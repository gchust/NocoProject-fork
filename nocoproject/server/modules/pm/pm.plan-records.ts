/**
 * `pmPlans` / `pmPlanOps` rows and the `PmPlan` view (NP-183, protocol-pm-assistant.md §4.1, §4.4, §4.6). A pending
 * or failed plan past `expiresAt` is written back as `expired` when read. A row's check result lives on its op row:
 * `errorCode` / `errorMessage`, and `preview` holds `{ runs, flags }`.
 */
import type { Conn } from '../shared/db.js';
import {
  fromJson,
  iso,
  isoOrNull,
  now,
  num,
  str,
  toJson,
} from '../shared/db.js';
import type {
  PmOperation,
  PmPlan,
  PmPlanOpStatus,
  PmPlanResult,
  PmPlanRow,
  PmPlanRowCheck,
  PmPlanRowFlag,
  PmPlanStatus,
  RunPreview,
} from '../shared/protocol.js';
import type { PlanRow } from './pm.plan-engine.js';

export interface PlanRecord {
  readonly id: string;
  readonly conversationIssueId: string;
  readonly runId: string | null;
  readonly agentId: string | null;
  readonly ownerUserId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly status: PmPlanStatus;
  readonly revision: number;
  readonly expiresAt: string;
  readonly executedAt: string | null;
  readonly result: PmPlanResult | null;
  readonly commentId: string | null;
  readonly createdAt: string;
}

export interface OpRecord {
  readonly id: string;
  readonly seq: number;
  readonly ref: string | null;
  readonly type: PmOperation['type'];
  readonly params: unknown;
  readonly baseline: Record<string, unknown> | null;
  readonly status: PmPlanOpStatus;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly preview: { runs: RunPreview[]; flags: PmPlanRowFlag[] };
  readonly resultType: string | null;
  readonly resultId: string | null;
  readonly warnings: string[];
}

const OPEN: readonly PmPlanStatus[] = ['pending', 'failed'];

function mapPlan(row: Record<string, unknown>): PlanRecord {
  return {
    id: str(row.id) ?? '',
    conversationIssueId: str(row.conversationIssueId) ?? '',
    runId: str(row.runId),
    agentId: str(row.agentId),
    ownerUserId: str(row.ownerUserId) ?? '',
    title: str(row.title) ?? '',
    summary: str(row.summary),
    status: (str(row.status) ?? 'pending') as PmPlanStatus,
    revision: num(row.revision, 1),
    expiresAt: iso(row.expiresAt),
    executedAt: isoOrNull(row.executedAt),
    result: fromJson<PmPlanResult>(row.result) ?? null,
    commentId: str(row.commentId),
    createdAt: iso(row.createdAt),
  };
}

function mapOp(row: Record<string, unknown>): OpRecord {
  const preview =
    fromJson<{ runs?: RunPreview[]; flags?: PmPlanRowFlag[] }>(row.preview) ??
    {};
  return {
    id: str(row.id) ?? '',
    seq: num(row.seq),
    ref: str(row.ref),
    type: (str(row.type) ?? 'issue.create') as PmOperation['type'],
    params: fromJson<unknown>(row.params) ?? {},
    baseline: fromJson<Record<string, unknown>>(row.baseline) ?? null,
    status: (str(row.status) ?? 'pending') as PmPlanOpStatus,
    errorCode: str(row.errorCode),
    errorMessage: str(row.errorMessage),
    preview: { runs: preview.runs ?? [], flags: preview.flags ?? [] },
    resultType: str(row.resultType),
    resultId: str(row.resultId),
    warnings: fromJson<string[]>(row.warnings) ?? [],
  };
}

export function isExpired(plan: PlanRecord, at = Date.now()): boolean {
  return OPEN.includes(plan.status) && new Date(plan.expiresAt).getTime() <= at;
}

/** The plan, with an overdue open plan written back as `expired`. */
export async function findPlan(
  conn: Conn,
  id: string,
): Promise<PlanRecord | null> {
  const row = await conn.query
    .selectFrom('pmPlans')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return null;
  const plan = mapPlan(row);
  if (!isExpired(plan)) return plan;
  await conn.query
    .updateTable('pmPlans')
    .set({ status: 'expired', updatedAt: now() })
    .where('id', '=', id)
    .where('status', 'in', [...OPEN])
    .execute();
  return { ...plan, status: 'expired' };
}

export async function planOps(conn: Conn, planId: string): Promise<OpRecord[]> {
  const rows = await conn.query
    .selectFrom('pmPlanOps')
    .selectAll()
    .where('planId', '=', planId)
    .orderBy('seq', 'asc')
    .execute();
  return rows.map(mapOp);
}

export function toPlanRows(ops: readonly OpRecord[]): PlanRow[] {
  return ops.map((op) => ({
    seq: op.seq,
    ref: op.ref,
    op: {
      type: op.type,
      ...(op.ref ? { ref: op.ref } : {}),
      params: op.params,
    } as PmOperation,
    removed: op.status === 'removed',
    baseline: op.baseline,
  }));
}

/** Stores a row's check. */
export async function writeCheck(
  conn: Conn,
  planId: string,
  check: PmPlanRowCheck,
  baseline: boolean,
): Promise<void> {
  await conn.query
    .updateTable('pmPlanOps')
    .set({
      errorCode: check.ok ? null : (check.errorCode ?? null),
      errorMessage: check.ok ? null : (check.errorMessage ?? null),
      preview: toJson({ runs: check.preview, flags: check.flags }),
      ...(baseline ? { baseline: toJson(check.baseline ?? null) } : {}),
    })
    .where('planId', '=', planId)
    .where('seq', '=', check.seq)
    .execute();
}

export function planView(plan: PlanRecord, ops: readonly OpRecord[]): PmPlan {
  const rows: PmPlanRow[] = ops.map((op) => ({
    seq: op.seq,
    ok: op.status === 'removed' || !op.errorCode,
    ...(op.errorCode
      ? { errorCode: op.errorCode, errorMessage: op.errorMessage ?? '' }
      : {}),
    preview: op.preview.runs,
    flags: op.preview.flags,
    ...(op.baseline ? { baseline: op.baseline } : {}),
    ref: op.ref,
    type: op.type,
    params: op.params,
    status: op.status,
    ...(op.resultType ? { resultType: op.resultType } : {}),
    ...(op.resultId ? { resultId: op.resultId } : {}),
    warnings: op.warnings,
  }));
  return {
    id: plan.id,
    conversationId: plan.conversationIssueId,
    status: plan.status,
    title: plan.title,
    summary: plan.summary,
    revision: plan.revision,
    expiresAt: plan.expiresAt,
    executable:
      plan.status === 'pending' &&
      !isExpired(plan) &&
      rows.some((row) => row.status !== 'removed') &&
      rows.every((row) => row.ok),
    rows,
    result: plan.result,
    createdAt: plan.createdAt,
    executedAt: plan.executedAt,
    commentId: plan.commentId,
  };
}
