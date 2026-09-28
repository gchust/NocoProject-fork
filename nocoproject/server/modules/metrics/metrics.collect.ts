/**
 * The raw figures behind the acceptance metrics (docs/phase1/iteration-3-contract.md §C). Every query is limited to
 * the report range (`from` inclusive, `to` exclusive, UTC) and to the issues in scope (not deleted; the requested
 * project; for members, not in a private project they cannot see) through a sub-query on `issues`.
 *
 * Definitions (also in docs/phase1/protocol-iteration-3.md §3):
 *
 * - adoption: active days / ISO weeks with an issue created, a comment or a run; issues created; distinct members
 *   with any activity.
 * - aiShare: issues that entered a done-category status in the range (by `status_changed` activity); those executed
 *   by an agent (current executor).
 * - trust: accepted / (accepted + rejected) executor proposals decided in the range; in_review → done over every exit
 *   from in_review; approved / (approved + rejected) approval requests decided in the range; in_review → in_progress
 *   over every exit from in_review.
 * - reliability: runs created in the range; failed; failures by reason; claim latency createdAt → dispatchedAt (p50,
 *   p95); run duration startedAt → finishedAt (p50, finished runs); lost = still dispatched / running with no
 *   progress for 3 hours.
 * - humanLoad: decision items created / resolved in the range; p50 createdAt → resolvedAt of those resolved; open
 *   decisions (unresolved, not archived) created before the end; created by type.
 */
import type { Expression, ExpressionBuilder, SqlBool } from '@nocobase/db';

import type { Conn } from '../shared/db.js';
import { fromJson, str, toDate } from '../shared/db.js';
import type {
  MetricsAdoption,
  MetricsAiShare,
  MetricsHumanLoad,
  MetricsReliability,
  MetricsTrust,
} from '../shared/protocol.js';

const LOST_AFTER_MS = 3 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export interface MetricsScope {
  readonly conn: Conn;
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
  readonly now: Date;
  readonly projectId: string | null;
  /** Private projects the viewer cannot see (empty for owner/admin). */
  readonly hidden: readonly string[];
  /** Status keys of the done category across the workflow templates. */
  readonly doneKeys: ReadonlySet<string>;
}

/** `column in (the issues in scope)`. */
function inScope(
  scope: MetricsScope,
  column: string,
): (eb: ExpressionBuilder) => Expression<SqlBool> {
  return (eb) => {
    let issues = eb
      .selectFrom('issues')
      .select('id')
      .where('deletedAt', 'is', null);
    if (scope.projectId)
      issues = issues.where('projectId', '=', scope.projectId);
    if (scope.hidden.length > 0)
      issues = issues.where((inner) =>
        inner.or([
          inner('projectId', 'is', null),
          inner('projectId', 'not in', scope.hidden),
        ]),
      );
    return eb(column, 'in', issues);
  };
}

export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

function dayOf(value: unknown): string | null {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

/** ISO week `YYYY-Www` of a UTC day. */
export function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date.getTime() + (3 - weekday) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - yearStart) / (7 * DAY_MS)) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function createdDays(
  scope: MetricsScope,
  table: 'comments' | 'runs',
  column: string,
): Promise<string[]> {
  let query = scope.conn.query
    .selectFrom(table)
    .select('createdAt')
    .where('createdAt', '>=', scope.from)
    .where('createdAt', '<', scope.to)
    .where(inScope(scope, column));
  if (table === 'runs') query = query.where('subjectType', '=', 'issue');
  const rows = await query.execute();
  return rows.map((row) => dayOf(row.createdAt)).filter((day) => day !== null);
}

export async function adoption(scope: MetricsScope): Promise<MetricsAdoption> {
  const issues = await scope.conn.query
    .selectFrom('issues')
    .select('createdAt')
    .where('createdAt', '>=', scope.from)
    .where('createdAt', '<', scope.to)
    .where(inScope(scope, 'id'))
    .execute();
  const days = new Set<string>([
    ...issues.map((row) => dayOf(row.createdAt)).filter((day) => day !== null),
    ...(await createdDays(scope, 'comments', 'issueId')),
    ...(await createdDays(scope, 'runs', 'subjectId')),
  ]);
  const members = await scope.conn.query
    .selectFrom('activities')
    .select('actorId')
    .distinct()
    .where('actorType', '=', 'user')
    .where('createdAt', '>=', scope.from)
    .where('createdAt', '<', scope.to)
    .where(inScope(scope, 'issueId'))
    .execute();
  return {
    activeWeeks: new Set(Array.from(days).map(isoWeek)).size,
    activeDays: days.size,
    issuesCreated: issues.length,
    activeMembers: members.filter((row) => str(row.actorId)).length,
  };
}

export interface StatusMove {
  readonly issueId: string;
  readonly from: string;
  readonly to: string;
}

/** Every `status_changed` activity in the range. */
export async function statusMoves(scope: MetricsScope): Promise<StatusMove[]> {
  const rows = await scope.conn.query
    .selectFrom('activities')
    .select(['issueId', 'details'])
    .where('action', '=', 'status_changed')
    .where('createdAt', '>=', scope.from)
    .where('createdAt', '<', scope.to)
    .where(inScope(scope, 'issueId'))
    .execute();
  return rows.map((row) => {
    const details = fromJson<Record<string, unknown>>(row.details) ?? {};
    return {
      issueId: str(row.issueId) ?? '',
      from: str(details.from) ?? '',
      to: str(details.to) ?? '',
    };
  });
}

export async function aiShare(
  scope: MetricsScope,
  moves: readonly StatusMove[],
): Promise<MetricsAiShare> {
  const delivered = Array.from(
    new Set(
      moves
        .filter((move) => scope.doneKeys.has(move.to))
        .map((move) => move.issueId),
    ),
  );
  const byAgent = delivered.length
    ? await scope.conn.query
        .selectFrom('issues')
        .select('id')
        .where('id', 'in', delivered)
        .where('executorType', '=', 'agent')
        .execute()
    : [];
  return {
    deliveredByAgent: byAgent.length,
    deliveredTotal: delivered.length,
    share: ratio(byAgent.length, delivered.length),
  };
}

async function decidedCounts(
  scope: MetricsScope,
  table: 'executorProposals' | 'approvalRequests',
  positive: readonly string[],
  negative: readonly string[],
): Promise<number | null> {
  const rows = await scope.conn.query
    .selectFrom(table)
    .select('status')
    .where('decidedAt', '>=', scope.from)
    .where('decidedAt', '<', scope.to)
    .where('status', 'in', [...positive, ...negative])
    .where(inScope(scope, 'issueId'))
    .execute();
  const accepted = rows.filter((row) =>
    positive.includes(str(row.status) ?? ''),
  ).length;
  return ratio(accepted, rows.length);
}

export async function trust(
  scope: MetricsScope,
  moves: readonly StatusMove[],
): Promise<MetricsTrust> {
  const exits = moves.filter(
    (move) => move.from === 'in_review' && move.to !== 'in_review',
  );
  return {
    proposalAcceptRate: await decidedCounts(
      scope,
      'executorProposals',
      ['accepted'],
      ['rejected'],
    ),
    reviewPassRate: ratio(
      exits.filter((move) => scope.doneKeys.has(move.to)).length,
      exits.length,
    ),
    approvalApproveRate: await decidedCounts(
      scope,
      'approvalRequests',
      ['approved'],
      ['rejected'],
    ),
    reworkRate: ratio(
      exits.filter((move) => move.to === 'in_progress').length,
      exits.length,
    ),
  };
}

function elapsed(start: unknown, end: unknown): number | null {
  const a = toDate(start);
  const b = toDate(end);
  return a && b ? Math.max(0, b.getTime() - a.getTime()) : null;
}

export async function reliability(
  scope: MetricsScope,
): Promise<MetricsReliability> {
  const rows = await scope.conn.query
    .selectFrom('runs')
    .select([
      'status',
      'failureReason',
      'createdAt',
      'dispatchedAt',
      'startedAt',
      'finishedAt',
    ])
    .where('subjectType', '=', 'issue')
    .where('createdAt', '>=', scope.from)
    .where('createdAt', '<', scope.to)
    .where(inScope(scope, 'subjectId'))
    .execute();
  const failuresByReason: Record<string, number> = {};
  const latencies: number[] = [];
  const durations: number[] = [];
  let failed = 0;
  let lost = 0;
  for (const row of rows) {
    const status = str(row.status) ?? '';
    if (status === 'failed') {
      failed += 1;
      const reason = str(row.failureReason) ?? 'unknown';
      failuresByReason[reason] = (failuresByReason[reason] ?? 0) + 1;
    }
    const latency = elapsed(row.createdAt, row.dispatchedAt);
    if (latency !== null) latencies.push(latency);
    if (status === 'completed' || status === 'failed') {
      const duration = elapsed(row.startedAt, row.finishedAt);
      if (duration !== null) durations.push(duration);
    }
    if (status === 'dispatched' || status === 'running') {
      const progress =
        toDate(row.startedAt) ??
        toDate(row.dispatchedAt) ??
        toDate(row.createdAt);
      if (progress && scope.now.getTime() - progress.getTime() > LOST_AFTER_MS)
        lost += 1;
    }
  }
  return {
    runs: rows.length,
    failedRuns: failed,
    failuresByReason,
    claimLatencyP50Ms: percentile(latencies, 0.5),
    claimLatencyP95Ms: percentile(latencies, 0.95),
    runDurationP50Ms: percentile(durations, 0.5),
    lostRuns: lost,
  };
}

export async function humanLoad(
  scope: MetricsScope,
): Promise<MetricsHumanLoad> {
  const base = () =>
    scope.conn.query
      .selectFrom('inboxItems')
      .select(['type', 'createdAt', 'resolvedAt'])
      .where('kind', '=', 'decision')
      .where(inScope(scope, 'issueId'));
  const created = await base()
    .where('createdAt', '>=', scope.from)
    .where('createdAt', '<', scope.to)
    .execute();
  const resolved = await base()
    .where('resolvedAt', '>=', scope.from)
    .where('resolvedAt', '<', scope.to)
    .execute();
  const open = await base()
    .where('resolvedAt', 'is', null)
    .where('archivedAt', 'is', null)
    .where('createdAt', '<', scope.to)
    .execute();
  const byType: Record<string, number> = {};
  for (const row of created) {
    const type = str(row.type) ?? 'unknown';
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    decisionsCreated: created.length,
    decisionsResolved: resolved.length,
    decisionResolveP50Ms: percentile(
      resolved
        .map((row) => elapsed(row.createdAt, row.resolvedAt))
        .filter((value) => value !== null),
      0.5,
    ),
    openDecisions: open.length,
    byType,
  };
}
