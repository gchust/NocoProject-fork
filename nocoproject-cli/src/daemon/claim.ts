/**
 * Claim loop: a global slot semaphore (default 20) shared by all runtimes, and a
 * coalescing trigger so WS wakeups, polls and freed slots never overlap claim calls.
 */
import { HttpError } from '../api/client.js';
import type { ClaimedRun, DaemonClaimRequest, DaemonClaimResponse, DaemonCompatibilityResponse } from '../protocol.js';
import type { Logger } from '../util/log.js';

export interface ClaimApi {
  claim(body: DaemonClaimRequest): Promise<DaemonClaimResponse & DaemonCompatibilityResponse>;
}

export interface ClaimLoopOptions {
  readonly api: ClaimApi;
  readonly daemonId: string;
  readonly maxConcurrent: number;
  readonly runtimeIds: () => readonly string[];
  /** Executes a claimed run; its slot is released when the promise settles. */
  readonly execute: (run: ClaimedRun) => Promise<unknown>;
  readonly logger: Logger;
  /** A 426 (a server from before NP-150). The loop keeps going; `runtimeIds` returns none while an upgrade is required. */
  readonly onProtocolMismatch: (error: HttpError) => void;
  /** The server's verdict on this daemon, when the claim response carries one (NP-150). */
  readonly onCompatibility?: (compatibility: NonNullable<DaemonCompatibilityResponse['compatibility']>) => void;
  readonly onUnknownRuntime?: () => void;
}

/** Splits `free` slots across runtimes as evenly as possible (earlier runtimes get the remainder). */
export function distributeSlots(free: number, runtimeIds: readonly string[]): { runtimeId: string; free: number }[] {
  if (free <= 0 || runtimeIds.length === 0) return [];
  const base = Math.floor(free / runtimeIds.length);
  let rest = free % runtimeIds.length;
  const slots: { runtimeId: string; free: number }[] = [];
  for (const runtimeId of runtimeIds) {
    const n = base + (rest > 0 ? 1 : 0);
    if (rest > 0) rest--;
    if (n > 0) slots.push({ runtimeId, free: n });
  }
  return slots;
}

export class ClaimLoop {
  private active = 0;
  private running: Promise<void> | undefined;
  private pending = false;
  private stopped = false;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly opts: ClaimLoopOptions) {}

  get activeRuns(): number {
    return this.active;
  }

  get freeSlots(): number {
    return Math.max(0, this.opts.maxConcurrent - this.active);
  }

  /** Requests a claim round; overlapping requests are coalesced into one follow-up round. */
  trigger(reason: string): void {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = this.round(reason).finally(() => {
      this.running = undefined;
      if (this.pending && !this.stopped) {
        this.pending = false;
        this.trigger('coalesced');
      }
    });
  }

  private async round(reason: string): Promise<void> {
    const slots = distributeSlots(this.freeSlots, this.opts.runtimeIds());
    if (slots.length === 0) return;
    let response: DaemonClaimResponse & DaemonCompatibilityResponse;
    try {
      // `configurationProtocol` keeps protocol 1 servers (NP-125 to NP-150) handing out work.
      response = await this.opts.api.claim({ daemonId: this.opts.daemonId, slots, configurationProtocol: 1 });
    } catch (error) {
      if (error instanceof HttpError && error.status === 426) {
        this.opts.onProtocolMismatch(error);
      } else if (error instanceof HttpError && error.status === 404) {
        this.opts.onUnknownRuntime?.();
      } else {
        this.opts.logger.warn('claim failed', { reason, error: (error as Error).message });
      }
      return;
    }
    if (response.compatibility) this.opts.onCompatibility?.(response.compatibility);
    const runs = response.runs ?? [];
    if (runs.length > 0) this.opts.logger.info('claimed runs', { reason, count: runs.length, ids: runs.map((r) => r.run.id).join(',') });
    for (const run of runs) this.launch(run);
    const perRuntime = new Map<string, number>();
    for (const run of runs) perRuntime.set(run.run.runtimeId, (perRuntime.get(run.run.runtimeId) ?? 0) + 1);
    // A runtime that filled every slot it asked for may have more work queued.
    if (slots.some((s) => (perRuntime.get(s.runtimeId) ?? 0) >= s.free) && this.freeSlots > 0) this.pending = true;
  }

  private launch(run: ClaimedRun): void {
    this.active += 1;
    const p = Promise.resolve()
      .then(() => this.opts.execute(run))
      .catch((error: unknown) => this.opts.logger.error('run crashed', { runId: run.run.id, error: (error as Error).message }))
      .finally(() => {
        this.active -= 1;
        this.inflight.delete(p);
        this.trigger('slotFreed');
      });
    this.inflight.add(p);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Resolves when every in-flight run has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}
