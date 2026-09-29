/**
 * Server sweeper (protocol.md §4.2). `sweep(now)` holds the logic and is what tests call; the provider only schedules
 * it every 30 seconds.
 *
 * Phase 0 runs one application instance. Every step is a guarded transition (`WHERE status = …`), so two sweepers
 * racing would not corrupt state, but they could both schedule work; a lock is Phase 1 work.
 */
import type { TxRunner } from '../shared/db.js';
import { str, toDate } from '../shared/db.js';
import {
  DISPATCHED_TIMEOUT_SECONDS,
  RUNTIME_OFFLINE_AFTER_SECONDS,
  RUNTIME_RECONNECT_GRACE_SECONDS,
  type FailureReason,
  type Run,
  type RunStatus,
} from '../shared/protocol.js';
import { failRunInTx, type FailureDeps } from './failure.js';
import {
  findRun,
  mapRun,
  revokeRunTokens,
  transitionRun,
} from './run.records.js';
import { emitRunStatus, emitWorkAvailable } from './run.service.js';

export interface SweepResult {
  readonly runtimesOffline: number;
  readonly dispatchedTimedOut: number;
  readonly leasesRequeued: number;
  readonly runningOrphaned: number;
  readonly deferredPromoted: number;
  readonly queuedExpired: number;
}

export interface SweeperService {
  sweep(now?: Date): Promise<SweepResult>;
}

/** Cron expression for the sweeper tick (six fields: every 30 seconds). */
export const SWEEP_CRON_TIME = '*/30 * * * * *';

function ago(now: Date, seconds: number): Date {
  return new Date(now.getTime() - seconds * 1000);
}

export type SweeperDeps = FailureDeps & { readonly tx: TxRunner };

async function runsWhere(
  deps: SweeperDeps,
  status: RunStatus,
  column: string,
  before: Date,
): Promise<Run[]> {
  const rows = await deps.tx
    .read()
    .query.selectFrom('runs')
    .selectAll()
    .where('status', '=', status)
    .where(column, '<', before)
    .limit(500)
    .execute();
  return rows.map(mapRun);
}

async function failRun(
  deps: SweeperDeps,
  run: Run,
  reason: FailureReason,
  from: readonly RunStatus[],
): Promise<boolean> {
  return deps.tx.run(async (tx) => {
    const current = await findRun(tx.conn, run.id);
    if (!current) return false;
    return failRunInTx(deps, tx, current, { reason, from });
  });
}

async function markRuntimesOffline(
  deps: SweeperDeps,
  now: Date,
): Promise<number> {
  const result = await deps.tx
    .read()
    .query.updateTable('runtimes')
    .set({ status: 'offline', updatedAt: now })
    .where('status', '=', 'online')
    .where((eb) =>
      eb.or([
        eb('lastSeenAt', 'is', null),
        eb('lastSeenAt', '<', ago(now, RUNTIME_OFFLINE_AFTER_SECONDS)),
      ]),
    )
    .execute();
  const count = result.updatedCount ?? 0;
  if (count > 0)
    await deps.tx.run(async (tx) => tx.emit({ type: 'agents.changed' }));
  return count;
}

async function failTimedOutDispatches(
  deps: SweeperDeps,
  now: Date,
): Promise<number> {
  let count = 0;
  for (const run of await runsWhere(
    deps,
    'dispatched',
    'dispatchedAt',
    ago(now, DISPATCHED_TIMEOUT_SECONDS),
  )) {
    if (await failRun(deps, run, 'runtimeRecovery', ['dispatched'])) count += 1;
  }
  return count;
}

async function requeueExpiredLeases(
  deps: SweeperDeps,
  now: Date,
): Promise<number> {
  let count = 0;
  for (const run of await runsWhere(
    deps,
    'dispatched',
    'leaseExpiresAt',
    now,
  )) {
    const moved = await deps.tx.run(async (tx) => {
      const ok = await transitionRun(tx.conn, run.id, ['dispatched'], {
        status: 'queued',
        leaseExpiresAt: null,
        dispatchedAt: null,
      });
      if (!ok) return false;
      await revokeRunTokens(tx.conn, run.id);
      emitRunStatus(tx, run, 'queued');
      await emitWorkAvailable(tx, run.runtimeId);
      return true;
    });
    if (moved) count += 1;
  }
  return count;
}

async function failOrphanedRunning(
  deps: SweeperDeps,
  now: Date,
): Promise<number> {
  const running = (
    await deps.tx
      .read()
      .query.selectFrom('runs')
      .selectAll()
      .where('status', '=', 'running')
      .limit(500)
      .execute()
  ).map(mapRun);
  const runtimeIds = Array.from(
    new Set(
      running.map((run) => run.runtimeId).filter((id): id is string => !!id),
    ),
  );
  const runtimes = runtimeIds.length
    ? await deps.tx
        .read()
        .query.selectFrom('runtimes')
        .select(['id', 'status', 'lastSeenAt'])
        .where('id', 'in', runtimeIds)
        .execute()
    : [];
  const threshold = ago(now, RUNTIME_RECONNECT_GRACE_SECONDS);
  let count = 0;
  for (const run of running) {
    const runtime = runtimes.find((row) => row.id === run.runtimeId);
    const lastSeen = runtime ? toDate(runtime.lastSeenAt) : null;
    const gone =
      !runtime ||
      // `upgrade_required` counts too: such a daemon may still finish a run, but not once it has gone silent.
      (str(runtime.status) !== 'online' && (!lastSeen || lastSeen < threshold));
    if (gone && (await failRun(deps, run, 'runtimeOffline', ['running'])))
      count += 1;
  }
  return count;
}

async function promoteDeferred(deps: SweeperDeps, now: Date): Promise<number> {
  let count = 0;
  const due = await deps.tx
    .read()
    .query.selectFrom('runs')
    .selectAll()
    .where('status', '=', 'deferred')
    .where('fireAt', '<=', now)
    .limit(500)
    .execute();
  for (const run of due.map(mapRun)) {
    const moved = await deps.tx.run(async (tx) => {
      const ok = await transitionRun(tx.conn, run.id, ['deferred'], {
        status: 'queued',
      });
      if (ok) {
        emitRunStatus(tx, run, 'queued');
        await emitWorkAvailable(tx, run.runtimeId);
      }
      return ok;
    });
    if (moved) count += 1;
  }
  return count;
}

/** Queued runs whose agent's runtime no longer exists can never be claimed (the claim joins on it). */
async function expireQueuedWithoutRuntime(deps: SweeperDeps): Promise<number> {
  const queued = (
    await deps.tx
      .read()
      .query.selectFrom('runs')
      .selectAll()
      .where('status', '=', 'queued')
      .limit(1000)
      .execute()
  ).map(mapRun);
  const agentIds = Array.from(new Set(queued.map((run) => run.agentId)));
  const agents = agentIds.length
    ? await deps.tx
        .read()
        .query.selectFrom('agents')
        .select(['id', 'runtimeId'])
        .where('id', 'in', agentIds)
        .execute()
    : [];
  const agentRuntime = new Map(
    agents.map((row) => [String(row.id as string), str(row.runtimeId)]),
  );
  const runtimeIds = Array.from(
    new Set(
      Array.from(agentRuntime.values()).filter((id): id is string => !!id),
    ),
  );
  const existing = new Set(
    runtimeIds.length
      ? (
          await deps.tx
            .read()
            .query.selectFrom('runtimes')
            .select('id')
            .where('id', 'in', runtimeIds)
            .execute()
        ).map((row) => String(row.id as string))
      : [],
  );
  let count = 0;
  for (const run of queued) {
    const runtimeId = agentRuntime.get(run.agentId);
    if (runtimeId && existing.has(runtimeId)) continue;
    if (await failRun(deps, run, 'queuedExpired', ['queued'])) count += 1;
  }
  return count;
}

async function sweep(
  deps: SweeperDeps,
  now = new Date(),
): Promise<SweepResult> {
  const runtimesOffline = await markRuntimesOffline(deps, now);
  // The 5-minute dispatch timeout is checked before the lease rule: a run whose daemon kept renewing the lease
  // but never started is a failed preparation, not a lost claim.
  const dispatchedTimedOut = await failTimedOutDispatches(deps, now);
  const leasesRequeued = await requeueExpiredLeases(deps, now);
  const runningOrphaned = await failOrphanedRunning(deps, now);
  const deferredPromoted = await promoteDeferred(deps, now);
  const queuedExpired = await expireQueuedWithoutRuntime(deps);
  return {
    runtimesOffline,
    dispatchedTimedOut,
    leasesRequeued,
    runningOrphaned,
    deferredPromoted,
    queuedExpired,
  };
}

export function createSweeperService(deps: SweeperDeps): SweeperService {
  return {
    sweep: (now) => sweep(deps, now),
  };
}
