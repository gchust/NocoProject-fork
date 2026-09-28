/**
 * Daemon lifecycle: detect tools → register → heartbeat (15s) → wake (WS + poll) → claim →
 * run; graceful shutdown kills agents, reports them for retry and deregisters.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonApi, HttpError, NetworkError } from '../api/client.js';
import type { DaemonSettings, ResolvedConfig } from '../config.js';
import type { AgentProvider, ClaimedRun, DaemonRegisterResponse } from '../protocol.js';
import { PROTOCOL_VERSION } from '../protocol.js';
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
  readonly config: ResolvedConfig & { serverUrl: string; apiKey: string };
  readonly settings: DaemonSettings;
  readonly logger: Logger;
  readonly adapters?: readonly DetectedAdapter[];
  readonly disableSocket?: boolean;
  readonly intervals?: DaemonIntervals;
}

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
  readonly protocolMismatch: boolean;
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
  private protocolMismatch = false;
  private lastHeartbeatAt: string | null = null;
  private state: DaemonSnapshot['state'] = 'starting';
  private readonly startedAt = new Date().toISOString();
  private binDir: string | undefined;

  constructor(private readonly opts: DaemonOptions) {
    this.api = new DaemonApi(opts.config.serverUrl, opts.config.apiKey);
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
    if (!registered) return;
    this.startLoops(registered);
    this.state = 'running';
    this.writeState();
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
      protocolVersion: PROTOCOL_VERSION,
      runtimes: [...this.adapters.values()].map((d) => ({
        provider: d.adapter.provider,
        version: d.version,
        capabilities: { resume: d.adapter.capabilities().resume, steering: d.adapter.capabilities().steering },
      })),
    });
    if (res.protocolVersion !== undefined && res.protocolVersion !== PROTOCOL_VERSION) {
      throw new HttpError(426, 'PROTOCOL_MISMATCH', `server speaks protocol ${res.protocolVersion}, daemon ${PROTOCOL_VERSION}`, 'POST', '/np/daemon/register');
    }
    this.runtimes = res.runtimes
      .filter((r) => this.adapters.has(r.provider))
      .map((r) => ({ id: r.id, provider: r.provider, version: this.adapters.get(r.provider)?.version ?? '' }));
    this.log.info('registered', { runtimes: this.runtimes.map((r) => `${r.provider}:${r.id}`).join(',') });
    return res;
  }

  /** Retries network/5xx failures until stopped; returns null on protocol mismatch. Throws on auth errors. */
  private async registerWithRetry(): Promise<DaemonRegisterResponse | null> {
    for (let attempt = 0; !this.shutdown.signal.aborted; attempt++) {
      try {
        return await this.register();
      } catch (error) {
        if (error instanceof HttpError && error.status === 426) {
          this.onProtocolMismatch(error);
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

  private onProtocolMismatch(error: HttpError): void {
    this.protocolMismatch = true;
    this.claim?.stop();
    this.log.error('!!! PROTOCOL MISMATCH: the server requires a different nocoproject-cli version. Claiming is stopped. Upgrade nocoproject-cli and restart the daemon.', {
      daemonProtocol: PROTOCOL_VERSION,
      error: error.message,
    });
    this.writeState();
  }

  private startLoops(reg: DaemonRegisterResponse): void {
    this.claim = new ClaimLoop({
      api: this.api,
      daemonId: this.opts.config.daemonId,
      maxConcurrent: this.opts.settings.maxConcurrent,
      runtimeIds: () => (this.protocolMismatch ? [] : this.runtimes.map((r) => r.id)),
      execute: (run) => this.execute(run),
      logger: this.log.child('claim'),
      onProtocolMismatch: (e) => this.onProtocolMismatch(e),
      onUnknownRuntime: () => void this.reregister(),
    });
    const heartbeatMs = this.opts.intervals?.heartbeatMs ?? reg.heartbeatIntervalMs ?? 15_000;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), heartbeatMs);
    this.wake = new Wake({
      serverUrl: this.opts.config.serverUrl,
      apiKey: this.opts.config.apiKey,
      pollIntervalMs: this.opts.settings.pollIntervalMs ?? reg.pollIntervalMs ?? 15_000,
      logger: this.log.child('wake'),
      disableSocket: this.opts.disableSocket,
      onWork: (reason) => this.claim?.trigger(reason),
      onCancel: (runId) => this.cancelHooks.get(runId)?.forEach((fn) => fn()),
    });
    this.wake.start();
    this.claim.trigger('startup');
  }

  private async heartbeat(): Promise<void> {
    if (this.protocolMismatch || this.runtimes.length === 0) return;
    try {
      await this.api.heartbeat({ daemonId: this.opts.config.daemonId, runtimeIds: this.runtimes.map((r) => r.id) });
      this.lastHeartbeatAt = new Date().toISOString();
    } catch (error) {
      if (error instanceof HttpError && error.status === 426) this.onProtocolMismatch(error);
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
      protocolMismatch: this.protocolMismatch,
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
