/**
 * Daemon lifecycle: detect tools → register → heartbeat (15s) → wake (WS + poll) → claim →
 * run; graceful shutdown kills agents, reports them for retry and deregisters.
 *
 * Compatibility (NP-150): the daemon offers protocols `SUPPORTED_PROTOCOLS.min..PROTOCOL_VERSION` and the server
 * answers with `compatibility`. When the daemon must be upgraded it keeps heartbeating (the computer shows "upgrade
 * required" with the command), stops claiming, records the command in `daemon.state.json` and warns every 10 minutes;
 * it never exits for it, because a service manager would only restart it into the same state. A server from before
 * NP-150 that refuses protocol 2 is retried with protocol 1.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonApi, daemonCredentials, HttpError, NetworkError } from '../api/client.js';
import type { DaemonSettings, ResolvedConfig } from '../config.js';
import type { AgentProvider, ClaimedRun, DaemonCompatibility, DaemonRegisterResponse } from '../protocol.js';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOLS, upgradeCommand } from '../protocol.js';
import { backoffDelay, sleep } from '../util/backoff.js';
import type { Logger } from '../util/log.js';
import { distPath } from '../util/paths.js';
import { CLI_VERSION } from '../version.js';
import { DEFAULT_PROVIDERS, detectAdapters, type DetectedAdapter } from './adapters/index.js';
import { ClaimLoop } from './claim.js';
import { ensureCliShim } from './env.js';
import { executeRun } from './runner.js';
import { Wake } from './wake.js';

export interface DaemonIntervals {
  readonly heartbeatMs?: number;
  readonly leaseMs?: number;
  readonly cancelPollMs?: number;
  readonly flushMs?: number;
}

export interface DaemonOptions {
  /** The daemon uses `computerKey` when set (NP-150), else the personal `apiKey`. */
  readonly config: ResolvedConfig & { serverUrl: string };
  readonly settings: DaemonSettings;
  readonly logger: Logger;
  readonly adapters?: readonly DetectedAdapter[];
  readonly disableSocket?: boolean;
  readonly intervals?: DaemonIntervals;
}

/** Why and how this daemon must be upgraded (`daemon.state.json`, `nocoproject daemon status`). */
export interface UpgradeRequired {
  readonly reason: string;
  readonly since: string;
  readonly latestVersion: string | null;
  readonly minVersion: string | null;
  readonly command: string;
}

const UPGRADE_WARN_EVERY_MS = 10 * 60_000;

/** The server refused the computer credential (revoked, unknown, owner disabled): the daemon idles and says so. */
export interface CredentialProblem {
  readonly code: string;
  readonly since: string;
  readonly command: string;
}
const REGISTER_REFUSED_RETRY_MS = 60_000;

export interface RuntimeInfo {
  readonly id: string;
  readonly provider: AgentProvider;
  readonly version: string;
}

export interface DaemonSnapshot {
  readonly pid: number;
  readonly version: string;
  readonly protocolVersion: number;
  readonly startedAt: string;
  readonly serverUrl: string;
  readonly daemonId: string;
  readonly deviceName: string;
  readonly runtimes: readonly RuntimeInfo[];
  readonly activeRuns: number;
  readonly maxConcurrent: number;
  readonly socket: string;
  /** Kept for older `daemon status` readers: true while `upgradeRequired` is set. */
  readonly protocolMismatch: boolean;
  readonly upgradeRequired: UpgradeRequired | null;
  /** NP-150: `computer` or `personalKey`. */
  readonly credential: 'computer' | 'personalKey';
  readonly credentialProblem: CredentialProblem | null;
  readonly compatibility: DaemonCompatibility | null;
  /** The protocol agreed with the server. */
  readonly negotiatedProtocol: number | null;
  /** What this process runs: `process.execPath` and the CLI entry (compared by `daemon start` / `daemon status`). */
  readonly execPath: string;
  readonly entry: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly state: 'starting' | 'running' | 'stopping' | 'stopped';
}

export class Daemon {
  readonly api: DaemonApi;
  private adapters = new Map<string, DetectedAdapter>();
  private runtimes: RuntimeInfo[] = [];
  private claim: ClaimLoop | undefined;
  private wake: Wake | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly shutdown = new AbortController();
  private readonly cancelHooks = new Map<string, Set<() => void>>();
  private upgrade: UpgradeRequired | null = null;
  private credentialProblem: CredentialProblem | null = null;
  private compatibility: DaemonCompatibility | null = null;
  private lastUpgradeWarnAt = 0;
  /** The protocol offered at register: lowered once when a server from before NP-150 refuses it. */
  private offeredProtocol: number = PROTOCOL_VERSION;
  private negotiatedProtocol: number | null = null;
  private lastHeartbeatAt: string | null = null;
  private state: DaemonSnapshot['state'] = 'starting';
  private readonly startedAt = new Date().toISOString();
  private binDir: string | undefined;

  constructor(private readonly opts: DaemonOptions) {
    const credentials = daemonCredentials(opts.config);
    if (!credentials) throw new Error('no daemon credential: run `nocoproject login --server <url> --computer-key-stdin`');
    this.api = new DaemonApi(opts.config.serverUrl, credentials);
  }

  private get log(): Logger {
    return this.opts.logger;
  }

  async start(): Promise<void> {
    const detected = this.opts.adapters ?? (await this.detect());
    for (const d of detected) this.adapters.set(d.adapter.provider, d);
    if (this.adapters.size === 0) throw new Error('No supported coding tools found (looked for: claude, opencode, codex). Install one or pass --providers echo.');
    mkdirSync(this.opts.settings.workspacesRoot, { recursive: true, mode: 0o700 });
    const cli = distPath('cli.js');
    if (existsSync(cli)) this.binDir = ensureCliShim(this.opts.config.home, cli);
    const registered = await this.registerWithRetry();
    if (registered) this.startLoops(registered);
    else if (!this.shutdown.signal.aborted) void this.registerLater();
    this.state = 'running';
    this.writeState();
  }

  /**
   * The server refused every protocol, or the computer credential: try again every minute (the server may be
   * upgraded meanwhile), or every ten minutes for a refused credential (an owner may be enabled again).
   */
  private async registerLater(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      await sleep(this.credentialProblem ? UPGRADE_WARN_EVERY_MS : REGISTER_REFUSED_RETRY_MS, this.shutdown.signal);
      if (this.shutdown.signal.aborted) return;
      const registered = await this.registerWithRetry().catch((error: unknown) => {
        this.log.warn('register failed', { error: (error as Error).message });
        return null;
      });
      if (registered) {
        this.startLoops(registered);
        this.writeState();
        return;
      }
    }
  }

  private async detect(): Promise<DetectedAdapter[]> {
    const { detected, missing } = await detectAdapters(this.opts.settings.providers ?? DEFAULT_PROVIDERS);
    for (const d of detected) this.log.info('detected tool', { provider: d.adapter.provider, version: d.version, path: d.path });
    if (missing.length) this.log.info('tools not available', { providers: missing.join(',') });
    return detected;
  }

  private async register(): Promise<DaemonRegisterResponse> {
    const res = await this.api.register({
      daemonId: this.opts.config.daemonId,
      deviceName: this.opts.config.deviceName,
      version: CLI_VERSION,
      protocolVersion: this.offeredProtocol,
      minProtocolVersion: SUPPORTED_PROTOCOLS.min,
      runtimes: [...this.adapters.values()].map((d) => ({
        provider: d.adapter.provider,
        version: d.version,
        capabilities: { resume: d.adapter.capabilities().resume, steering: d.adapter.capabilities().steering },
      })),
    });
    const agreed = res.protocolVersion ?? this.offeredProtocol;
    this.negotiatedProtocol = agreed;
    this.runtimes = res.runtimes
      .filter((r) => this.adapters.has(r.provider))
      .map((r) => ({ id: r.id, provider: r.provider, version: this.adapters.get(r.provider)?.version ?? '' }));
    this.log.info('registered', { runtimes: this.runtimes.map((r) => `${r.provider}:${r.id}`).join(','), protocol: agreed });
    if (res.compatibility) this.applyCompatibility(res.compatibility);
    else if (agreed < SUPPORTED_PROTOCOLS.min || agreed > PROTOCOL_VERSION)
      this.requireUpgrade({ reason: 'serverProtocol', latestVersion: null, minVersion: null }, `server speaks protocol ${agreed}`);
    else this.clearUpgrade();
    if (res.compatibility && res.compatibility.status !== 'unsupported' && res.compatibility.updateAvailable)
      this.log.warn(`nocoproject-cli ${res.compatibility.latestVersion} is available (running ${CLI_VERSION}); upgrade with: ${this.commandFor(res.compatibility.latestVersion)}`);
    return res;
  }

  /**
   * Retries network/5xx failures with backoff until stopped, and a refused protocol with a lower one (a server from
   * before NP-150); null when every protocol is refused. Throws on auth errors.
   */
  private async registerWithRetry(): Promise<DaemonRegisterResponse | null> {
    for (let attempt = 0; !this.shutdown.signal.aborted; attempt++) {
      try {
        return await this.register();
      } catch (error) {
        if (error instanceof HttpError && error.status === 426) {
          if (this.offeredProtocol > SUPPORTED_PROTOCOLS.min) {
            this.offeredProtocol -= 1;
            this.log.info('server refused the protocol; offering an older one', { protocol: this.offeredProtocol });
            continue;
          }
          this.onProtocolMismatch(error);
          this.offeredProtocol = PROTOCOL_VERSION;
          return null;
        }
        if (this.isCredentialRefusal(error)) {
          this.onCredentialRefused(error as HttpError);
          return null;
        }
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error;
        const delay = backoffDelay(attempt, 1000, 30_000);
        const kind = error instanceof NetworkError ? 'network' : 'server';
        this.log.warn(`register failed (${kind}); retrying`, { delayMs: delay, error: (error as Error).message });
        await sleep(delay, this.shutdown.signal);
      }
    }
    return null;
  }

  /** A 401 for a computer credential: it was revoked, is unknown, or its owner is disabled. */
  private isCredentialRefusal(error: unknown): boolean {
    return this.api.credentials.kind === 'computerKey' && error instanceof HttpError && error.status === 401;
  }

  /** Stops claiming and says how to recover; the process stays up so a service manager does not restart it in a loop. */
  private onCredentialRefused(error: HttpError): void {
    const first = this.credentialProblem === null;
    this.credentialProblem = {
      code: error.code,
      since: this.credentialProblem?.since ?? new Date().toISOString(),
      command: `nocoproject login --server ${this.opts.config.serverUrl} --computer-key-stdin`,
    };
    if (first || Date.now() - this.lastUpgradeWarnAt >= UPGRADE_WARN_EVERY_MS) {
      this.lastUpgradeWarnAt = Date.now();
      this.log.error(`!!! COMPUTER CREDENTIAL REFUSED (${error.code}): claiming is paused. Add the computer again in the app, then run: ${this.credentialProblem.command}`);
    }
    this.writeState();
  }

  /** A 426 from a server from before NP-150 (it says nothing more): claiming pauses, heartbeats go on. */
  private onProtocolMismatch(error: HttpError): void {
    this.requireUpgrade({ reason: 'protocolMismatch', latestVersion: null, minVersion: null }, error.message);
  }

  private commandFor(latestVersion: string | null): string {
    return upgradeCommand(this.opts.config.serverUrl, CLI_VERSION, latestVersion ?? undefined);
  }

  private applyCompatibility(compatibility: DaemonCompatibility): void {
    this.compatibility = compatibility;
    if (compatibility.negotiatedProtocol !== null) this.negotiatedProtocol = compatibility.negotiatedProtocol;
    if (compatibility.status === 'unsupported')
      this.requireUpgrade(compatibility, `the server requires nocoproject-cli ${compatibility.minVersion} or later (latest ${compatibility.latestVersion}; reason ${compatibility.reason})`);
    else this.clearUpgrade();
  }

  private requireUpgrade(info: { reason: string; latestVersion: string | null; minVersion: string | null }, detail: string): void {
    const first = this.upgrade === null;
    this.upgrade = {
      reason: info.reason,
      since: this.upgrade?.since ?? new Date().toISOString(),
      latestVersion: info.latestVersion,
      minVersion: info.minVersion,
      command: this.commandFor(info.latestVersion),
    };
    if (first || Date.now() - this.lastUpgradeWarnAt >= UPGRADE_WARN_EVERY_MS) {
      this.lastUpgradeWarnAt = Date.now();
      this.log.error(`!!! PROTOCOL MISMATCH: upgrade required. Claiming is paused; heartbeats continue. Upgrade with: ${this.upgrade.command}`, {
        cli: CLI_VERSION,
        daemonProtocol: PROTOCOL_VERSION,
        detail,
      });
    }
    this.writeState();
  }

  private clearUpgrade(): void {
    if (!this.upgrade) return;
    this.upgrade = null;
    this.log.info('the server accepts this daemon again; claiming resumes');
    this.writeState();
    this.claim?.trigger('compatible');
  }

  private startLoops(reg: DaemonRegisterResponse): void {
    this.claim = new ClaimLoop({
      api: this.api,
      daemonId: this.opts.config.daemonId,
      maxConcurrent: this.opts.settings.maxConcurrent,
      runtimeIds: () => (this.upgrade || this.credentialProblem ? [] : this.runtimes.map((r) => r.id)),
      execute: (run) => this.execute(run),
      logger: this.log.child('claim'),
      onProtocolMismatch: (e) => this.onProtocolMismatch(e),
      onCompatibility: (c) => this.applyCompatibility(c),
      onUnknownRuntime: () => void this.reregister(),
    });
    const heartbeatMs = this.opts.intervals?.heartbeatMs ?? reg.heartbeatIntervalMs ?? 15_000;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), heartbeatMs);
    this.wake = new Wake({
      serverUrl: this.opts.config.serverUrl,
      apiKey: this.api.credentials.kind === 'apiKey' ? this.api.credentials.apiKey : undefined,
      longPoll: (after, timeoutS, signal) => this.api.wakeups(after, timeoutS, signal),
      pollIntervalMs: this.opts.settings.pollIntervalMs ?? reg.pollIntervalMs ?? 15_000,
      logger: this.log.child('wake'),
      disableSocket: this.opts.disableSocket,
      onWork: (reason) => this.claim?.trigger(reason),
      onCancel: (runId) => this.cancelHooks.get(runId)?.forEach((fn) => fn()),
    });
    this.wake.start();
    this.claim.trigger('startup');
  }

  /** Runs also while an upgrade is required: the server shows the computer as "upgrade required", not offline. */
  private async heartbeat(): Promise<void> {
    if (this.runtimes.length === 0) return;
    try {
      const res = await this.api.heartbeat({
        daemonId: this.opts.config.daemonId,
        runtimeIds: this.runtimes.map((r) => r.id),
        version: CLI_VERSION,
        protocolVersion: this.negotiatedProtocol ?? this.offeredProtocol,
        minProtocolVersion: SUPPORTED_PROTOCOLS.min,
      });
      this.lastHeartbeatAt = new Date().toISOString();
      if (this.credentialProblem) {
        this.credentialProblem = null;
        this.log.info('the computer credential is accepted again; claiming resumes');
        this.claim?.trigger('credential');
      }
      if (res?.compatibility) this.applyCompatibility(res.compatibility);
      else if (this.upgrade) this.requireUpgrade(this.upgrade, 'still refused');
    } catch (error) {
      if (error instanceof HttpError && error.status === 426) this.onProtocolMismatch(error);
      else if (this.isCredentialRefusal(error)) this.onCredentialRefused(error as HttpError);
      else if (error instanceof HttpError && error.status === 404) await this.reregister();
      else this.log.warn('heartbeat failed', { error: (error as Error).message });
    }
    this.writeState();
  }

  private async reregister(): Promise<void> {
    try {
      await this.register();
    } catch (error) {
      if (error instanceof HttpError && error.status === 426) this.onProtocolMismatch(error);
      else this.log.warn('re-register failed', { error: (error as Error).message });
    }
  }

  private execute(run: ClaimedRun): Promise<unknown> {
    const detected = this.adapters.get(run.agent.provider) ?? this.adapterForRuntime(run.run.runtimeId);
    const log = this.log.child('runner');
    if (!detected) {
      log.error('claimed a run for an unavailable provider', { runId: run.run.id, provider: run.agent.provider });
      return this.api.fail(run.run.id, { reason: 'agentError.missingExecutable', detail: `provider ${run.agent.provider} is not available on this machine` }).catch(() => undefined);
    }
    const promise = executeRun(run, {
      api: this.api,
      adapter: detected.adapter,
      serverUrl: this.opts.config.serverUrl,
      workspacesRoot: this.opts.settings.workspacesRoot,
      binDir: this.binDir,
      home: this.opts.config.home,
      idleWatchdogMs: this.opts.settings.idleWatchdogMs,
      leaseIntervalMs: this.opts.intervals?.leaseMs,
      cancelPollMs: this.opts.intervals?.cancelPollMs,
      flushIntervalMs: this.opts.intervals?.flushMs,
      logger: log,
      shutdownSignal: this.shutdown.signal,
      onCancelSignal: (runId, handler) => this.addCancelHook(runId, handler),
    });
    this.writeState();
    return promise.finally(() => this.writeState());
  }

  private adapterForRuntime(runtimeId: string): DetectedAdapter | undefined {
    const rt = this.runtimes.find((r) => r.id === runtimeId);
    return rt ? this.adapters.get(rt.provider) : undefined;
  }

  private addCancelHook(runId: string, handler: () => void): () => void {
    const set = this.cancelHooks.get(runId) ?? new Set();
    set.add(handler);
    this.cancelHooks.set(runId, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.cancelHooks.delete(runId);
    };
  }

  snapshot(): DaemonSnapshot {
    return {
      pid: process.pid,
      version: CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: this.startedAt,
      serverUrl: this.opts.config.serverUrl,
      daemonId: this.opts.config.daemonId,
      deviceName: this.opts.config.deviceName,
      runtimes: this.runtimes,
      activeRuns: this.claim?.activeRuns ?? 0,
      maxConcurrent: this.opts.settings.maxConcurrent,
      socket: this.wake?.state ?? 'disabled',
      protocolMismatch: this.upgrade !== null,
      upgradeRequired: this.upgrade,
      credential: this.api.credentials.kind === 'computerKey' ? 'computer' : 'personalKey',
      credentialProblem: this.credentialProblem,
      compatibility: this.compatibility,
      negotiatedProtocol: this.negotiatedProtocol,
      execPath: process.execPath,
      entry: process.argv[1] ? realpathOr(process.argv[1]) : null,
      lastHeartbeatAt: this.lastHeartbeatAt,
      state: this.state,
    };
  }

  private writeState(): void {
    try {
      writeFileSync(join(this.opts.config.home, 'daemon.state.json'), `${JSON.stringify(this.snapshot(), null, 2)}\n`, { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  /** Graceful shutdown: stop claiming, kill agents (reported as runtimeRecovery → retried), deregister. */
  async stop(timeoutMs = 20_000): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') return;
    this.state = 'stopping';
    this.log.info('shutting down', { activeRuns: this.claim?.activeRuns ?? 0 });
    this.wake?.stop();
    this.claim?.stop();
    clearInterval(this.heartbeatTimer);
    this.shutdown.abort();
    await Promise.race([this.claim?.drain(), sleep(timeoutMs)]);
    if (this.runtimes.length > 0) {
      await this.api.deregister(this.opts.config.daemonId).catch((error: unknown) => this.log.warn('deregister failed', { error: (error as Error).message }));
    }
    this.state = 'stopped';
    this.writeState();
    this.log.info('stopped');
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
