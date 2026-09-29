/**
 * Long-poll wakeups for daemons that authenticate with a computer credential (NP-150): the platform WebSocket accepts
 * sessions only, and a computer credential never becomes one. `GET /np/daemon/wakeups?after=<cursor>&timeout=<s>`
 * answers with the owner's `np:daemon` messages newer than `after`, waiting up to `timeout` seconds for one.
 *
 * Messages are kept per user in a short ring (the newest 100, at most a minute old), so several daemons of one owner
 * each see every message and a daemon between two polls misses nothing. Without `after` the call answers at once with
 * the current cursor. Wakeups stay hints: the daemon's periodic claim poll remains the source of truth.
 */
import type { DomainEventBus } from '../shared/events.js';
import type { DaemonWakeupPayload } from '../shared/protocol.js';

export interface DaemonWakeupBatch {
  readonly cursor: number;
  readonly events: readonly DaemonWakeupPayload[];
}

export interface DaemonWakeups {
  wait(
    userId: string,
    after: number | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DaemonWakeupBatch>;
  close(): void;
}

const KEEP = 100;
const KEEP_MS = 60_000;
export const WAKEUP_MAX_TIMEOUT_MS = 30_000;

interface Entry {
  readonly seq: number;
  readonly at: number;
  readonly payload: DaemonWakeupPayload;
}

export function createDaemonWakeups(bus: DomainEventBus): DaemonWakeups {
  let seq = 0;
  const rings = new Map<string, Entry[]>();
  const waiters = new Map<string, Set<() => void>>();

  const push = (userId: string, payload: DaemonWakeupPayload) => {
    seq += 1;
    const now = Date.now();
    const ring = (rings.get(userId) ?? []).filter(
      (entry) => now - entry.at < KEEP_MS,
    );
    ring.push({ seq, at: now, payload });
    rings.set(userId, ring.slice(-KEEP));
    for (const wake of waiters.get(userId) ?? []) wake();
  };

  const unsubscribe = bus.subscribe((event) => {
    if (event.type === 'daemon.workAvailable')
      push(event.userId, { kind: 'workAvailable', runtimeId: event.runtimeId });
    else if (event.type === 'daemon.cancelRequested')
      push(event.userId, { kind: 'cancelRequested', runId: event.runId });
  });

  const newer = (userId: string, after: number) =>
    (rings.get(userId) ?? [])
      .filter((entry) => entry.seq > after)
      .map((entry) => entry.payload);

  return {
    async wait(userId, after, timeoutMs, signal) {
      if (after === null || after > seq) return { cursor: seq, events: [] };
      const ready = newer(userId, after);
      if (ready.length > 0) return { cursor: seq, events: ready };
      await new Promise<void>((resolve) => {
        const set = waiters.get(userId) ?? new Set<() => void>();
        waiters.set(userId, set);
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          set.delete(done);
          if (set.size === 0) waiters.delete(userId);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(Math.max(timeoutMs, 0), WAKEUP_MAX_TIMEOUT_MS),
        );
        signal?.addEventListener('abort', done);
        set.add(done);
      });
      return { cursor: seq, events: newer(userId, after) };
    },
    close() {
      unsubscribe();
      for (const set of waiters.values()) for (const wake of set) wake();
    },
  };
}
