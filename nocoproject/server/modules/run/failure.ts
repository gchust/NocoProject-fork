/**
 * Run failure handling (protocol.md §1.2, §4 `fail`, §4.2): classify, record, poison the session when needed,
 * schedule an automatic retry through the trigger service, and put an abandoned in-progress issue back to todo.
 * Shared by the daemon `fail` endpoint and the sweeper.
 */
import type { Actor } from '../shared/activity.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { now } from '../shared/db.js';
import { notFound, conflict } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import {
  RETRYABLE_FAILURE_REASONS,
  SESSION_POISONING_FAILURE_REASONS,
  type DaemonFailRequest,
  type DaemonReportPhase1Extras,
  type FailureReason,
  type Run,
  type RunStatus,
} from '../shared/protocol.js';
import {
  EXECUTING_STATUSES,
  findRun,
  isTerminalRunStatus,
  revokeRunTokens,
  transitionRun,
} from './run.records.js';
import { checkoutReport, emitRunStatus } from './run.service.js';
import { upsertSession } from './sessions.js';

const FAILURE_REASONS: readonly FailureReason[] = [
  'runtimeOffline',
  'queuedExpired',
  'runtimeRecovery',
  'environmentPrepareFailed',
  'cancelled',
  'timeout',
  'agentBlocked',
  'apiInvalidRequest',
  'agentError.providerAuth',
  'agentError.providerQuota',
  'agentError.providerRateLimit',
  'agentError.providerServerError',
  'agentError.providerNetwork',
  'agentError.modelUnavailable',
  'agentError.contextOverflow',
  'agentError.missingConfig',
  'agentError.missingExecutable',
  'agentError.versionUnsupported',
  'agentError.processFailure',
  'agentError.emptyOutput',
  'agentError.agentTimeout',
  'agentError.unknown',
];

/** Unknown reason codes are recorded as `agentError.unknown` rather than rejected. */
export function classifyFailure(reason: unknown): FailureReason {
  return (FAILURE_REASONS as readonly unknown[]).includes(reason)
    ? (reason as FailureReason)
    : 'agentError.unknown';
}

/** Attempts allowed for a reason: `providerNetwork` gets 3, everything else keeps the run's own limit. */
export function maxAttemptsFor(run: Run, reason: FailureReason): number {
  return reason === 'agentError.providerNetwork'
    ? Math.max(run.maxAttempts, 3)
    : run.maxAttempts;
}

export function isRetryable(reason: FailureReason): boolean {
  return RETRYABLE_FAILURE_REASONS.includes(reason);
}

/** Hooks into the modules a failure affects; resolved lazily to keep the module graph acyclic. */
export interface FailureCollaborators {
  /** trigger.service: create the retry run (the trigger module is the only place runs are created). */
  scheduleRetry(
    tx: Tx,
    failed: Run,
    maxAttempts: number,
    reason: FailureReason,
  ): Promise<unknown>;
  /** issue.service: in_progress → todo when nothing else is working on the issue. */
  resetAbandonedIssue(tx: Tx, issueId: string): Promise<boolean>;
}

export interface FailureDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly collaborators: () => FailureCollaborators;
}

export interface FailOptions {
  readonly reason: FailureReason;
  readonly detail?: string | null;
  readonly providerSessionId?: string | null;
  readonly workDir?: string | null;
  readonly sessionPoisoned?: boolean;
  readonly branchName?: string | null;
  readonly repoUrl?: string | null;
  /** Statuses the run may be failed from; defaults to dispatched | running. */
  readonly from?: readonly RunStatus[];
}

/**
 * Fails `run` inside `tx`. Returns false when the run had already left the allowed statuses (another writer won),
 * in which case nothing else happens.
 */
export async function failRunInTx(
  deps: FailureDeps,
  tx: Tx,
  run: Run,
  options: FailOptions,
): Promise<boolean> {
  const { reason } = options;
  const checkout = {
    ...(options.branchName ? { branchName: options.branchName } : {}),
    ...(options.repoUrl ? { repoUrl: options.repoUrl } : {}),
  };
  const moved = await transitionRun(
    tx.conn,
    run.id,
    options.from ?? EXECUTING_STATUSES,
    {
      status: 'failed',
      failureReason: reason,
      failureDetail: options.detail ?? null,
      finishedAt: now(),
      leaseExpiresAt: null,
      providerSessionId: options.providerSessionId ?? run.providerSessionId,
      workDir: options.workDir ?? run.workDir,
      ...checkout,
    },
  );
  if (!moved) return false;
  await revokeRunTokens(tx.conn, run.id);

  const poisoned =
    options.sessionPoisoned === true ||
    SESSION_POISONING_FAILURE_REASONS.includes(reason);
  if (poisoned || options.providerSessionId || checkout.branchName) {
    await upsertSession(tx.conn, deps.ids, run, {
      providerSessionId: options.providerSessionId ?? run.providerSessionId,
      workDir: options.workDir ?? run.workDir,
      poisoned,
      ...checkout,
    });
  }

  const collaborators = deps.collaborators();
  const maxAttempts = maxAttemptsFor(run, reason);
  const retried =
    isRetryable(reason) && run.attempt < maxAttempts
      ? (await collaborators.scheduleRetry(tx, run, maxAttempts, reason)) !==
        null
      : false;
  await collaborators.resetAbandonedIssue(tx, run.subjectId);
  emitRunStatus(tx, run, 'failed');
  tx.emit({
    type: 'run.failed',
    runId: run.id,
    issueId: run.subjectId,
    agentId: run.agentId,
    reason,
    final: !retried,
  });
  return true;
}

/** The daemon `fail` endpoint. */
export async function failRun(
  deps: FailureDeps,
  runId: string,
  input: DaemonFailRequest & DaemonReportPhase1Extras,
): Promise<Run> {
  return deps.tx.run(async (tx) => {
    const run = await findRun(tx.conn, runId);
    if (!run) throw notFound('Run');
    if (run.status === 'failed') return run;
    const failed = await failRunInTx(deps, tx, run, {
      reason: classifyFailure(input.reason),
      detail: input.detail ?? null,
      providerSessionId: input.providerSessionId ?? null,
      workDir: input.workDir ?? null,
      sessionPoisoned: input.sessionPoisoned === true,
      ...checkoutReport(input),
    });
    if (!failed)
      throw conflict(
        'RUN_STATE_CONFLICT',
        `Run is ${run.status}; expected dispatched or running.`,
      );
    return (await findRun(tx.conn, runId)) ?? run;
  });
}

export interface RunRecoveryService {
  fail(
    runId: string,
    input: DaemonFailRequest & DaemonReportPhase1Extras,
  ): Promise<Run>;
  /** Manual retry from the browser: a new run for the same agent, subject and thread. */
  retry(actor: Actor, runId: string): Promise<Run>;
}

export function createRunRecoveryService(
  deps: FailureDeps & {
    manualRetry: (tx: Tx, run: Run, actor: Actor) => Promise<{ runId: string }>;
  },
): RunRecoveryService {
  return {
    fail: (runId, input) => failRun(deps, runId, input),
    async retry(actor, runId) {
      return deps.tx.run(async (tx) => {
        const run = await findRun(tx.conn, runId);
        if (!run) throw notFound('Run');
        if (!isTerminalRunStatus(run.status)) {
          throw conflict(
            'RUN_STATE_CONFLICT',
            `Run is ${run.status}; only finished runs can be retried.`,
          );
        }
        const { runId: retryId } = await deps.manualRetry(tx, run, actor);
        return (await findRun(tx.conn, retryId)) as Run;
      });
    },
  };
}
