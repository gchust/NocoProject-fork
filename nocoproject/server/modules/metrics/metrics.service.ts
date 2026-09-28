/**
 * `GET /np/metrics` (docs/phase1/iteration-3-contract.md §C): the six groups of acceptance metrics for a UTC date
 * range, the thresholds from `settings.metricThresholds` and a status per thresholded metric (`ok` / `warn`, `n/a`
 * without data). Owner/admin see everything; members only the issues they can see. Cost reuses the usage service,
 * so its visibility and pricing rules apply unchanged. The figures and their definitions: `metrics.collect.ts`.
 */
import type { Actor } from '../shared/activity.js';
import { hiddenProjectIds, viewerOf } from '../shared/authz.js';
import type { TxRunner } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  MetricStatus,
  MetricThresholdKey,
  MetricThresholds,
  MetricsCost,
  MetricsReport,
} from '../shared/protocol.js';
import {
  METRIC_THRESHOLD_DIRECTIONS,
  METRIC_THRESHOLD_KEYS,
} from '../shared/protocol.js';
import { validateDate } from '../shared/validate.js';
import type { SettingsService } from '../system/settings.service.js';
import type { UsageService } from '../usage/usage.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import {
  adoption,
  aiShare,
  humanLoad,
  reliability,
  statusMoves,
  trust,
  type MetricsScope,
} from './metrics.collect.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 3600 * 1000;

export interface MetricsQuery {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly projectId?: string | null;
}

export interface MetricsService {
  report(actor: Actor, query: MetricsQuery): Promise<MetricsReport>;
}

export interface MetricsDeps {
  readonly tx: TxRunner;
  readonly settings: SettingsService;
  readonly workflows: WorkflowService;
  readonly usage: () => UsageService;
}

/** `from` / `to` as `YYYY-MM-DD` (to inclusive), defaulting to the last 30 days; at most 366 days. */
export function metricsRange(query: MetricsQuery): {
  from: string;
  to: string;
  start: Date;
  end: Date;
} {
  const today = new Date().toISOString().slice(0, 10);
  const to = query.to ? (validateDate(query.to, 'to') ?? today) : today;
  const end = new Date(new Date(`${to}T00:00:00Z`).getTime() + DAY_MS);
  const from = query.from
    ? (validateDate(query.from, 'from') ?? to)
    : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS)
        .toISOString()
        .slice(0, 10);
  const start = new Date(`${from}T00:00:00Z`);
  const days = (end.getTime() - start.getTime()) / DAY_MS;
  if (days < 1 || days > MAX_RANGE_DAYS)
    throw invalid(
      'INVALID_RANGE',
      `from must not be after to, and the range is at most ${MAX_RANGE_DAYS} days.`,
    );
  return { from, to, start, end };
}

export function metricStatus(
  key: MetricThresholdKey,
  value: number | null,
  thresholds: MetricThresholds,
): MetricStatus {
  if (value === null) return 'n/a';
  const threshold = thresholds[key];
  const ok =
    METRIC_THRESHOLD_DIRECTIONS[key] === 'min'
      ? value >= threshold
      : value <= threshold;
  return ok ? 'ok' : 'warn';
}

async function cost(
  deps: MetricsDeps,
  actor: Actor,
  range: { from: string; to: string },
  projectId: string | null,
  deliveredTotal: number,
): Promise<MetricsCost> {
  const usage = await deps.usage().query(actor, {
    from: range.from,
    to: range.to,
    groupBy: 'agent',
    projectId,
  });
  const estimatedCost = usage.totals.estimatedCost;
  return {
    inputTokens: usage.totals.inputTokens,
    outputTokens: usage.totals.outputTokens,
    estimatedCost,
    costPerDeliveredIssue:
      estimatedCost !== null && deliveredTotal > 0
        ? estimatedCost / deliveredTotal
        : null,
    byAgent: usage.rows.map((row) => ({
      agentId: row.key,
      name: row.name,
      cost: row.estimatedCost,
    })),
  };
}

async function doneKeys(deps: MetricsDeps): Promise<Set<string>> {
  const keys = new Set<string>(['done']);
  for (const workflow of await deps.workflows.list())
    for (const status of workflow.definition.statuses)
      if (status.category === 'done') keys.add(status.key);
  return keys;
}

async function report(
  deps: MetricsDeps,
  actor: Actor,
  query: MetricsQuery,
): Promise<MetricsReport> {
  const range = metricsRange(query);
  const conn = deps.tx.read();
  const viewer = await viewerOf(conn, actor);
  const projectId = query.projectId || null;
  const scope: MetricsScope = {
    conn,
    from: range.start,
    to: range.end,
    now: new Date(),
    projectId,
    hidden: await hiddenProjectIds(conn, viewer),
    doneKeys: await doneKeys(deps),
  };
  const moves = await statusMoves(scope);
  const share = await aiShare(scope, moves);
  const groups = {
    adoption: await adoption(scope),
    aiShare: share,
    trust: await trust(scope, moves),
    reliability: await reliability(scope),
    cost: await cost(deps, actor, range, projectId, share.deliveredTotal),
    humanLoad: await humanLoad(scope),
  };
  const thresholds = (await deps.settings.read(conn)).metricThresholds;
  const values: Record<MetricThresholdKey, number | null> = {
    aiShare: groups.aiShare.share,
    proposalAcceptRate: groups.trust.proposalAcceptRate,
    claimLatencyP50Ms: groups.reliability.claimLatencyP50Ms,
    lostRuns: groups.reliability.lostRuns,
    decisionResolveP50Ms: groups.humanLoad.decisionResolveP50Ms,
  };
  const statuses = Object.fromEntries(
    METRIC_THRESHOLD_KEYS.map((key) => [
      key,
      metricStatus(key, values[key], thresholds),
    ]),
  ) as Record<MetricThresholdKey, MetricStatus>;
  return {
    from: range.from,
    to: range.to,
    projectId,
    generatedAt: scope.now.toISOString(),
    ...groups,
    thresholds,
    statuses,
  };
}

export function createMetricsService(deps: MetricsDeps): MetricsService {
  return { report: (actor, query) => report(deps, actor, query) };
}
