/**
 * Orchestrates one claimed run: lease renewal → environment → brief → prompt →
 * start → adapter → event stream → complete / fail / cancel-ack.
 */
import { HttpError, isTransient } from '../api/client.js';
import type {
  DaemonCompleteRequest,
  DaemonReportPhase1Extras,
  DaemonFailRequest,
  DaemonRunStatusResponse,
  DaemonStartRequest,
  FailureReason,
  RunEventInput,
} from '../protocol.js';
import { AGENT_ENV_REDACT_MIN_LENGTH, SESSION_POISONING_FAILURE_REASONS } from '../protocol.js';
import { withRetry } from '../util/backoff.js';
import type { Logger } from '../util/log.js';
import { type ClaimedRunV1, readCheckoutRecord, reasoningEffortOf, writeRunContext } from '../run-context.js';
import { forgetSecret, redactKnownSecrets, redactText, registerSecret } from '../util/redact.js';
import type { AgentAdapter, RunResult, RunSpec } from './adapters/types.js';
import { nowIso } from './adapters/types.js';
import { buildBrief, buildTurnPrompt, writeBrief } from './brief.js';
import { classifyFailure } from './classify.js';
import { buildAgentEnv, filterAgentEnv, prepareRunEnvironment, type RunEnvironment } from './env.js';
import { writeSkills } from './skills.js';
import { EventStreamer } from './stream.js';
import { CancelWatcher, IdleWatchdog, type StopReason } from './watchdog.js';

export interface RunnerApi {
  lease(runId: string): Promise<unknown>;
  start(runId: string, body: DaemonStartRequest): Promise<unknown>;
  events(runId: string, body: { events: readonly RunEventInput[] }): Promise<unknown>;
  status(runId: string): Promise<DaemonRunStatusResponse>;
  complete(runId: string, body: DaemonCompleteRequest): Promise<unknown>;
  fail(runId: string, body: DaemonFailRequest): Promise<unknown>;
  cancelAck(runId: string): Promise<unknown>;
}

export interface RunnerDeps {
  readonly api: RunnerApi;
  readonly adapter: AgentAdapter;
  readonly serverUrl: string;
  readonly workspacesRoot: string;
  readonly binDir?: string;
  /** Daemon state dir, passed to agents as NOCOPROJECT_HOME (shared repo cache). */
  readonly home?: string;
  readonly idleWatchdogMs: number;
  readonly leaseIntervalMs?: number;
  readonly cancelPollMs?: number;
  readonly flushIntervalMs?: number;
  readonly logger: Logger;
  /** Registers a handler for WS `cancelRequested`; returns an unregister function. */
  readonly onCancelSignal?: (runId: string, handler: () => void) => () => void;
  /** Aborted when the daemon shuts down. */
  readonly shutdownSignal?: AbortSignal;
}

export type RunOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly reason: FailureReason }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'abandoned'; readonly why: string };

const MAX_DETAIL = 4000;
const MAX_SUMMARY = 2000;

const reportRetry = { attempts: 5, baseMs: 500, maxMs: 8000, shouldRetry: isTransient } as const;

function startLeaseRenewal(deps: RunnerDeps, runId: string): () => void {
  const timer = setInterval(() => {
    deps.api.lease(runId).catch((error: unknown) => deps.logger.warn('lease renewal failed', { runId, error: (error as Error).message }));
  }, deps.leaseIntervalMs ?? 15_000);
  return () => clearInterval(timer);
}

interface AgentAttempt {
  readonly result: RunResult;
  readonly stopReason?: StopReason | 'shutdown';
  readonly idle: boolean;
}

async function runAgent(deps: RunnerDeps, spec: RunSpec, streamer: EventStreamer): Promise<AgentAttempt> {
  const log = deps.logger;
  let handle;
  try {
    handle = await deps.adapter.start(spec, { log: (line) => log.debug(line, { runId: spec.runId }) });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const reason = err.code === 'ENOENT' ? 'agentError.missingExecutable' : undefined;
    return { result: { exitCode: null, errorText: err.message, classifiedFailure: reason, visibleEvents: 0 }, idle: false };
  }
  let stopReason: StopReason | 'shutdown' | undefined;
  const kill = (): void => void handle.kill();
  const watchdog = new IdleWatchdog(deps.idleWatchdogMs, () => {
    log.warn('agent idle watchdog fired; killing agent', { runId: spec.runId, idleMs: deps.idleWatchdogMs });
    kill();
  });
  const cancel = new CancelWatcher({
    runId: spec.runId,
    intervalMs: deps.cancelPollMs,
    getStatus: (id) => deps.api.status(id),
    logger: log,
    onStop: (reason, status) => {
      stopReason ??= reason;
      log.info('stopping agent', { runId: spec.runId, reason, status });
      kill();
    },
  });
  const unhook = deps.onCancelSignal?.(spec.runId, () => cancel.trigger());
  const onShutdown = (): void => {
    stopReason ??= 'shutdown';
    kill();
  };
  deps.shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
  watchdog.start();
  cancel.start();
  try {
    for await (const event of handle.events) {
      streamer.push(event);
      watchdog.touch();
    }
    const result = await handle.result;
    return { result, stopReason, idle: watchdog.hasFired };
  } finally {
    watchdog.stop();
    cancel.stop();
    unhook?.();
    deps.shutdownSignal?.removeEventListener('abort', onShutdown);
  }
}

function decideFailure(attempt: AgentAttempt): FailureReason | null {
  const r = attempt.result;
  if (attempt.idle) return 'agentError.agentTimeout';
  if (r.classifiedFailure) return r.classifiedFailure;
  const ok = r.exitCode === 0 && !r.errorText;
  if (ok && r.visibleEvents > 0) return null;
  return classifyFailure({
    errorText: r.errorText,
    exitCode: r.exitCode,
    signal: r.signal,
    emptyOutput: ok && r.visibleEvents === 0,
  });
}

interface Prepared {
  readonly env: RunEnvironment;
  readonly spec: RunSpec;
  /** Status lines for the run's event stream (skipped env names, rejected skill paths). */
  readonly notes: readonly string[];
}

async function prepare(deps: RunnerDeps, claimed: ClaimedRunV1): Promise<Prepared> {
  const caps = deps.adapter.capabilities();
  const env = prepareRunEnvironment(deps.workspacesRoot, claimed, caps.resume);
  writeRunContext(env.workDir, claimed);
  const skills = writeSkills(env.workDir, claimed.agent.skills, caps.nativeSkillsDir);
  writeBrief(env.workDir, caps.briefFile, redactKnownSecrets(buildBrief(claimed)));
  const prompt = buildTurnPrompt(claimed, { resumed: Boolean(env.resumeSessionId) });
  const agentEnv = buildAgentEnv({ serverUrl: deps.serverUrl, token: claimed.token, claimed, binDir: deps.binDir, workDir: env.workDir, home: deps.home });
  const spec: RunSpec = {
    runId: claimed.run.id,
    workDir: env.workDir,
    logsDir: env.logsDir,
    prompt,
    env: agentEnv,
    model: claimed.agent.model ?? undefined,
    resumeSessionId: env.resumeSessionId,
    reasoningEffort: reasoningEffortOf(claimed),
  };
  const skipped = filterAgentEnv(claimed.agent.env).skipped;
  const notes = [...(skipped.length ? [`Skipped reserved or invalid environment variables: ${skipped.join(', ')}`] : []), ...skills.warnings];
  return { env, spec, notes };
}

/** Agent env values (≥ 6 characters) join the redaction table for the run's lifetime (§G). */
function agentSecrets(claimed: ClaimedRunV1): string[] {
  return Object.values(filterAgentEnv(claimed.agent.env).vars).filter((v) => v.length >= AGENT_ENV_REDACT_MIN_LENGTH);
}

/** Executes a claimed run end to end. Never throws. */
export async function executeRun(claimed: ClaimedRunV1, deps: RunnerDeps): Promise<RunOutcome> {
  const runId = claimed.run.id;
  const log = deps.logger.child(`run:${runId}`);
  registerSecret(claimed.token);
  const secrets = agentSecrets(claimed);
  for (const value of secrets) registerSecret(value, { minLength: AGENT_ENV_REDACT_MIN_LENGTH });
  const stopLease = startLeaseRenewal(deps, runId);
  try {
    let prepared: Prepared;
    try {
      prepared = await prepare(deps, claimed);
    } catch (error) {
      log.error('environment preparation failed', { error: (error as Error).message });
      await report(deps, log, runId, 'fail', { reason: 'environmentPrepareFailed', detail: redactText((error as Error).message) });
      return { kind: 'failed', reason: 'environmentPrepareFailed' };
    }
    const { env, spec, notes } = prepared;
    for (const note of notes) log.warn(note);
    try {
      await withRetry(() => deps.api.start(runId, { providerSessionId: spec.resumeSessionId, workDir: env.workDir }), reportRetry);
    } catch (error) {
      log.warn('could not mark run as started; abandoning', { error: (error as Error).message });
      return { kind: 'abandoned', why: (error as Error).message };
    }
    stopLease();
    log.info('agent starting', { provider: deps.adapter.provider, workDir: env.workDir, resume: spec.resumeSessionId ?? 'fresh' });
    return await runAndReport(deps, log, claimed, env, spec, notes);
  } finally {
    stopLease();
    forgetSecret(claimed.token);
    for (const value of secrets) forgetSecret(value);
  }
}

async function runAndReport(deps: RunnerDeps, log: Logger, claimed: ClaimedRunV1, env: RunEnvironment, spec: RunSpec, notes: readonly string[]): Promise<RunOutcome> {
  const runId = claimed.run.id;
  const streamer = new EventStreamer(deps.api, runId, { logger: log, flushIntervalMs: deps.flushIntervalMs });
  streamer.push({ type: 'status', content: `Starting ${deps.adapter.provider} in ${env.workDir}${spec.resumeSessionId ? ` (resuming ${spec.resumeSessionId})` : ''}`, at: nowIso() });
  for (const note of notes) streamer.push({ type: 'status', content: note, at: nowIso() });
  let attempt = await runAgent(deps, spec, streamer);
  if (attempt.result.resumeRejected && !attempt.stopReason) {
    log.warn('provider rejected the session resume; retrying once with a fresh session');
    streamer.push({ type: 'status', content: 'Previous session could not be resumed; starting a fresh session', at: nowIso() });
    attempt = await runAgent(deps, { ...spec, resumeSessionId: undefined }, streamer);
  }
  const r = attempt.result;
  const failure = attempt.stopReason ? null : decideFailure(attempt);
  const branch = checkoutExtras(env.workDir);
  streamer.push({ type: 'status', content: `Agent exited (code ${r.exitCode ?? 'none'}${r.signal ? `, signal ${r.signal}` : ''})`, at: nowIso() });
  await streamer.close();

  if (attempt.stopReason === 'cancelRequested') {
    await report(deps, log, runId, 'cancelAck', undefined);
    return { kind: 'cancelled' };
  }
  if (attempt.stopReason === 'runTerminal') return { kind: 'abandoned', why: 'run became terminal on the server' };
  if (attempt.stopReason === 'shutdown') {
    const body = { reason: 'runtimeRecovery' as const, detail: 'daemon shut down while the agent was running', providerSessionId: r.sessionId, workDir: env.workDir, ...branch };
    await report(deps, log, runId, 'fail', body);
    return { kind: 'failed', reason: 'runtimeRecovery' };
  }
  if (!failure) {
    const summary = r.summary ? redactText(r.summary).slice(0, MAX_SUMMARY) : undefined;
    await report(deps, log, runId, 'complete', { providerSessionId: r.sessionId, workDir: env.workDir, summary, usage: r.usage, ...branch });
    log.info('run completed');
    return { kind: 'completed' };
  }
  const detail = redactText(r.errorText || (attempt.idle ? `no agent output for ${deps.idleWatchdogMs}ms` : 'agent produced no output')).slice(-MAX_DETAIL);
  const body: DaemonFailRequest & DaemonReportPhase1Extras = {
    reason: failure,
    detail,
    providerSessionId: r.sessionId,
    workDir: env.workDir,
    sessionPoisoned: SESSION_POISONING_FAILURE_REASONS.includes(failure),
    ...branch,
  };
  await report(deps, log, runId, 'fail', body);
  log.warn('run failed', { reason: failure });
  return { kind: 'failed', reason: failure };
}

/** `branchName` / `repoUrl` from `<workDir>/.nocoproject/checkout.json`, when the agent checked out a repo. */
export function checkoutExtras(workDir: string): DaemonReportPhase1Extras {
  const record = readCheckoutRecord(workDir);
  return record ? { branchName: record.branchName, repoUrl: record.url } : {};
}

type ReportKind = 'complete' | 'fail' | 'cancelAck';

async function report(deps: RunnerDeps, log: Logger, runId: string, kind: ReportKind, body: unknown): Promise<void> {
  try {
    await withRetry(() => {
      if (kind === 'complete') return deps.api.complete(runId, body as DaemonCompleteRequest);
      if (kind === 'fail') return deps.api.fail(runId, body as DaemonFailRequest);
      return deps.api.cancelAck(runId);
    }, reportRetry);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : undefined;
    log.error(`reporting ${kind} failed`, { status, error: (error as Error).message });
  }
}
