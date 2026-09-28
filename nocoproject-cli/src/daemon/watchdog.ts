/**
 * Idle watchdog (no agent output for N ms → kill) and cancel watcher (polls run status
 * every 5s; also triggered by the WS `cancelRequested` wakeup).
 */
import type { DaemonRunStatusResponse } from '../protocol.js';
import { silentLogger, type Logger } from '../util/log.js';

export class IdleWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private fired = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
  ) {}

  get hasFired(): boolean {
    return this.fired;
  }

  start(): void {
    this.touch();
  }

  touch(): void {
    if (this.timeoutMs <= 0 || this.fired) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fired = true;
      this.onIdle();
    }, this.timeoutMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export type StopReason = 'cancelRequested' | 'runTerminal';

export interface CancelWatcherOptions {
  readonly runId: string;
  readonly intervalMs?: number;
  readonly getStatus: (runId: string) => Promise<DaemonRunStatusResponse>;
  readonly onStop: (reason: StopReason, status?: string) => void;
  readonly logger?: Logger;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class CancelWatcher {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private reason: StopReason | undefined;
  private readonly logger: Logger;

  constructor(private readonly opts: CancelWatcherOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  get stopReason(): StopReason | undefined {
    return this.reason;
  }

  start(): void {
    this.schedule();
  }

  /** Called by the WS wakeup handler. */
  trigger(): void {
    this.fire('cancelRequested');
  }

  private fire(reason: StopReason, status?: string): void {
    if (this.reason || this.stopped) return;
    this.reason = reason;
    this.stop();
    this.opts.onStop(reason, status);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), this.opts.intervalMs ?? 5000);
  }

  private async poll(): Promise<void> {
    try {
      const s = await this.opts.getStatus(this.opts.runId);
      if (s.cancelRequested) return this.fire('cancelRequested', s.status);
      if (TERMINAL.has(s.status)) return this.fire('runTerminal', s.status);
    } catch (error) {
      this.logger.debug('status poll failed', { runId: this.opts.runId, error: (error as Error).message });
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
