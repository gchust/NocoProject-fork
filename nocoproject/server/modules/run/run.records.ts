/**
 * Row mapping, lookups and guarded status transitions for the `runs` table.
 */
import type { Conn } from '../shared/db.js';
import { iso, isoOrNull, num, str } from '../shared/db.js';
import type { FailureReason, Run, RunStatus } from '../shared/protocol.js';

/** A run with the checkout the daemon reported (iteration 1). */
export type RunV1 = Run & {
  readonly branchName: string | null;
  readonly repoUrl: string | null;
};

/** Statuses the pending-run unique index covers: a new trigger coalesces into such a run. */
export const PENDING_STATUSES: readonly RunStatus[] = [
  'queued',
  'deferred',
  'dispatched',
];
/** Statuses that count as "the agent is working on this" for the claim rule and concurrency limit. */
export const EXECUTING_STATUSES: readonly RunStatus[] = [
  'dispatched',
  'running',
];
/** Every non-terminal status. */
export const ACTIVE_STATUSES: readonly RunStatus[] = [
  'queued',
  'deferred',
  'dispatched',
  'running',
];
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

const RUN_STATUSES: readonly string[] = [
  ...ACTIVE_STATUSES,
  ...TERMINAL_STATUSES,
];

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function mapRun(row: Record<string, unknown>): RunV1 {
  const status = str(row.status) ?? 'queued';
  return {
    id: str(row.id) ?? '',
    agentId: str(row.agentId) ?? '',
    runtimeId: str(row.runtimeId),
    kind: 'issue',
    status: (RUN_STATUSES.includes(status) ? status : 'queued') as RunStatus,
    priority: num(row.priority),
    attempt: num(row.attempt, 1),
    maxAttempts: num(row.maxAttempts, 2),
    retryOfRunId: str(row.retryOfRunId),
    subjectType: 'issue',
    subjectId: str(row.subjectId) ?? '',
    threadScope: str(row.threadScope),
    actorUserId: str(row.actorUserId),
    ownerUserId: str(row.ownerUserId),
    fireAt: isoOrNull(row.fireAt),
    leaseExpiresAt: isoOrNull(row.leaseExpiresAt),
    dispatchedAt: isoOrNull(row.dispatchedAt),
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    failureReason: str(row.failureReason) as FailureReason | null,
    failureDetail: str(row.failureDetail),
    cancelRequestedAt: isoOrNull(row.cancelRequestedAt),
    cancelledById: str(row.cancelledById),
    resultSummary: str(row.resultSummary),
    providerSessionId: str(row.providerSessionId),
    workDir: str(row.workDir),
    branchName: str(row.branchName),
    repoUrl: str(row.repoUrl),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function findRun(
  conn: Conn,
  runId: string,
): Promise<RunV1 | null> {
  const row = await conn.query
    .selectFrom('runs')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirst();
  return row ? mapRun(row) : null;
}

/**
 * Updates a run only while it is still in one of `from`. Returns false when another writer moved it first, which
 * makes every transition idempotent and safe against the sweeper racing a daemon call.
 */
export async function transitionRun(
  conn: Conn,
  runId: string,
  from: readonly RunStatus[],
  values: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const result = await conn.query
    .updateTable('runs')
    .set({ ...values, updatedAt: new Date() })
    .where('id', '=', runId)
    .where('status', 'in', from)
    .execute();
  return (result.updatedCount ?? 0) > 0;
}

/** Revokes every live token of a run (terminal status, or re-queued for another claim). */
export async function revokeRunTokens(
  conn: Conn,
  runId: string,
): Promise<void> {
  await conn.query
    .updateTable('runTokens')
    .set({ revokedAt: new Date() })
    .where('runId', '=', runId)
    .where('revokedAt', 'is', null)
    .execute();
}

/** Owner of the runtime a run is bound to, for daemon wakeups. */
export async function runtimeOwnerOf(
  conn: Conn,
  runtimeId: string | null,
): Promise<string | null> {
  if (!runtimeId) return null;
  const row = await conn.query
    .selectFrom('runtimes')
    .select('ownerUserId')
    .where('id', '=', runtimeId)
    .executeTakeFirst();
  return row ? str(row.ownerUserId) : null;
}
