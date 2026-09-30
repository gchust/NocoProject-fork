import { toDateOnly } from './format.js';
import type { UsageGroupBy, UsageRow } from './types.js';

/**
 * Usage figures as the usage page and the issue panel show them (iteration 2 §I). Pure, so the range default and the
 * number formatting are tested without rendering.
 */

/** The `conversation` grouping's key for every project manager conversation run (NP-183 §6.6). */
export const USAGE_CONVERSATION_KEY = 'pm';

export const USAGE_GROUPS: readonly UsageGroupBy[] = [
  'agent',
  'issue',
  'project',
  'day',
  'model',
  'actor',
  'conversation',
];

export function readUsageGroup(value: string | null): UsageGroupBy {
  return USAGE_GROUPS.includes(value as UsageGroupBy)
    ? (value as UsageGroupBy)
    : 'agent';
}

/** The last `days` calendar days ending today, as `YYYY-MM-DD` (default 30 days, today included). */
export function defaultUsageRange(
  today: Date = new Date(),
  days = 30,
): { readonly from: string; readonly to: string } {
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  start.setDate(start.getDate() - (days - 1));
  return {
    from: toDateOnly(start) ?? '',
    to: toDateOnly(today) ?? '',
  };
}

/** "—" when no price matched (`estimatedCost: null`), otherwise US dollars; sub-cent amounts keep four decimals. */
export function formatCost(
  cost: number | null | undefined,
  locale: string,
): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return '—';
  const small = cost !== 0 && Math.abs(cost) < 0.01;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: small ? 4 : 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(cost);
}

/** Token counts in compact notation (12.3K, 4.5M); exact below a thousand. */
export function formatTokens(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1000) {
    return new Intl.NumberFormat(locale).format(value);
  }
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function totalTokens(row: UsageRow): number {
  return (
    row.inputTokens +
    row.outputTokens +
    row.cacheReadTokens +
    row.cacheWriteTokens
  );
}

/** Rows by cost (unpriced last), then by total tokens, so the heaviest consumers come first. */
export function sortUsageRows(
  rows: readonly UsageRow[],
  groupBy: UsageGroupBy,
): UsageRow[] {
  if (groupBy === 'day')
    return [...rows].sort((a, b) => a.key.localeCompare(b.key));
  return [...rows].sort((a, b) => {
    const costA = a.estimatedCost ?? -1;
    const costB = b.estimatedCost ?? -1;
    if (costA !== costB) return costB - costA;
    return totalTokens(b) - totalTokens(a);
  });
}

/** The row for one issue out of an issue-grouped answer, or null when it has no runs in range. */
export function usageForIssue(
  rows: readonly UsageRow[],
  issueId: string,
): UsageRow | null {
  return rows.find((row) => row.key === issueId) ?? null;
}
