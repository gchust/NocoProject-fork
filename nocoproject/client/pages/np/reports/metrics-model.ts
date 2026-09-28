import {
  metricDefinition,
  metricStatus,
  metricThreshold,
  metricValue,
} from '../api-iter3.js';
import type { MetricRaw, MetricStatus, MetricsReport } from '../types-iter3.js';
import { formatCost, formatTokens } from '../usage-model.js';

/**
 * The six acceptance metric groups (§C, plan 10.2) as the reports page lays them out: each metric with its kind (how
 * it is formatted), value, the server's calculation note when it sends one, and a status against its threshold.
 */

export type MetricKind = 'count' | 'percent' | 'duration' | 'cost' | 'tokens';

export type MetricGroupKey =
  'adoption' | 'aiShare' | 'trust' | 'reliability' | 'cost' | 'humanLoad';

export interface MetricItem {
  readonly key: string;
  readonly kind: MetricKind;
  readonly value: number | null;
  readonly definition: string | null;
  readonly status: MetricStatus;
  readonly threshold: {
    readonly value: number;
    readonly rule: 'min' | 'max';
  } | null;
}

export interface MetricGroup {
  readonly key: MetricGroupKey;
  readonly items: readonly MetricItem[];
}

const LAYOUT: readonly {
  readonly key: MetricGroupKey;
  readonly items: readonly (readonly [string, MetricKind])[];
}[] = [
  {
    key: 'adoption',
    items: [
      ['activeWeeks', 'count'],
      ['activeDays', 'count'],
      ['issuesCreated', 'count'],
      ['activeMembers', 'count'],
    ],
  },
  {
    key: 'aiShare',
    items: [
      ['share', 'percent'],
      ['deliveredByAgent', 'count'],
      ['deliveredTotal', 'count'],
    ],
  },
  {
    key: 'trust',
    items: [
      ['proposalAcceptRate', 'percent'],
      ['reviewPassRate', 'percent'],
      ['approvalApproveRate', 'percent'],
      ['reworkRate', 'percent'],
    ],
  },
  {
    key: 'reliability',
    items: [
      ['runs', 'count'],
      ['failedRuns', 'count'],
      ['lostRuns', 'count'],
      ['claimLatencyP50Ms', 'duration'],
      ['claimLatencyP95Ms', 'duration'],
      ['runDurationP50Ms', 'duration'],
    ],
  },
  {
    key: 'cost',
    items: [
      ['estimatedCost', 'cost'],
      ['costPerDeliveredIssue', 'cost'],
      ['inputTokens', 'tokens'],
      ['outputTokens', 'tokens'],
    ],
  },
  {
    key: 'humanLoad',
    items: [
      ['decisionsCreated', 'count'],
      ['decisionsResolved', 'count'],
      ['openDecisions', 'count'],
      ['decisionResolveP50Ms', 'duration'],
    ],
  },
];

export const METRIC_GROUP_KEYS: readonly MetricGroupKey[] = LAYOUT.map(
  (group) => group.key,
);

export function metricGroups(report: MetricsReport): MetricGroup[] {
  return LAYOUT.map((group) => {
    const source = report[group.key] as unknown as Record<string, MetricRaw>;
    return {
      key: group.key,
      items: group.items.map(([key, kind]) => {
        const raw = source[key];
        const value = metricValue(raw);
        return {
          key,
          kind,
          value,
          definition: metricDefinition(raw),
          status: metricStatus(key, value, report),
          threshold: metricThreshold(key, report.thresholds),
        };
      }),
    };
  });
}

/** How many metrics with a threshold are off target, for the header summary. */
export function warnCount(groups: readonly MetricGroup[]): number {
  return groups
    .flatMap((group) => group.items)
    .filter((item) => item.status === 'warn').length;
}

/** A duration in the largest unit that keeps it readable: 850 ms, 2.4 s, 3.5 min, 5.2 h, 1.3 d. */
export function formatDuration(ms: number, locale: string): string {
  const pick = (): [Intl.NumberFormatOptions['unit'], number] => {
    if (ms < 1000) return ['millisecond', ms];
    if (ms < 60_000) return ['second', ms / 1000];
    if (ms < 3_600_000) return ['minute', ms / 60_000];
    if (ms < 86_400_000) return ['hour', ms / 3_600_000];
    return ['day', ms / 86_400_000];
  };
  const [unit, value] = pick();
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'millisecond' ? 0 : 1,
  }).format(value);
}

export function formatMetric(
  kind: MetricKind,
  value: number | null,
  locale: string,
): string {
  if (value === null) return '—';
  switch (kind) {
    case 'percent':
      return new Intl.NumberFormat(locale, {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(value);
    case 'duration':
      return formatDuration(value, locale);
    case 'cost':
      return formatCost(value, locale);
    case 'tokens':
      return formatTokens(value, locale);
    case 'count':
      return new Intl.NumberFormat(locale).format(value);
  }
}

/** Record rows sorted by count, largest first, for the breakdown tables. */
export function breakdownRows(
  counts: Readonly<Record<string, number>>,
): { readonly key: string; readonly count: number }[] {
  return Object.entries(counts)
    .filter(([, count]) => typeof count === 'number')
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
