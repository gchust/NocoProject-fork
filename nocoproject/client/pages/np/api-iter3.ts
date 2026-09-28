import type { ApiClient } from '@nocobase/app-client';

import { normalizeBoardBody } from './api.js';
import { unwrap, unwrapList } from './api-iter2.js';
import type {
  BoardGroup,
  IssueActivity,
  IssueFilters,
  IssueListItem,
  Label,
  LabelColor,
} from './types.js';
import type {
  ActivityPage,
  BoardGroupV3,
  IssueListPage,
  MetricRaw,
  MetricStatus,
  MetricThresholds,
  MetricsQuery,
  MetricsReport,
  WorkflowListItem,
} from './types-iter3.js';

/**
 * Request functions for iteration 3 (`docs/phase1/iteration-3-contract.md` §C, §D, §F): cursor pages of issues, one
 * board column at a time, older activities, the ⌘K search, metrics, workflow templates and label management.
 * Knowledge lives in `api-knowledge.ts`.
 *
 * The server is written in parallel, so every normalizer accepts `{ data }` and a bare body, and a missing
 * `nextCursor` reads as the last page: the pages keep working against the iteration 2 server, which returns whole
 * lists.
 */

const id = (value: string): string => encodeURIComponent(value);

export const ISSUE_PAGE_SIZE = 50;
export const ACTIVITY_PAGE_SIZE = 50;

function cursorOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function issueQuery(filters: IssueFilters): Record<string, string | undefined> {
  return {
    q: filters.q || undefined,
    statusKey: filters.statusKey || undefined,
    projectId: filters.projectId || undefined,
    labelId: filters.labelId || undefined,
    ownerUserId: filters.ownerUserId || undefined,
    executorId: filters.executorId || undefined,
    parentIssueId: filters.parentIssueId || undefined,
  };
}

// ---------- §D issue pages ----------

/** `{ data, nextCursor }`, `{ data: { data, nextCursor } }` or a bare list (the last and only page). */
export function normalizeIssuePage(body: unknown): IssueListPage {
  if (Array.isArray(body)) {
    return { data: body as IssueListItem[], nextCursor: null };
  }
  const record = (body ?? {}) as { data?: unknown; nextCursor?: unknown };
  if (Array.isArray(record.data)) {
    return {
      data: record.data as IssueListItem[],
      nextCursor: cursorOf(record.nextCursor),
    };
  }
  if (record.data && typeof record.data === 'object') {
    return normalizeIssuePage(record.data);
  }
  return { data: [], nextCursor: null };
}

export async function fetchIssuePage(
  api: ApiClient,
  filters: IssueFilters,
  options: {
    readonly cursor?: string | null;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<IssueListPage> {
  const body = await api.request<unknown>({
    path: 'np/issues',
    query: {
      ...issueQuery(filters),
      cursor: options.cursor ?? undefined,
      limit: options.limit ?? ISSUE_PAGE_SIZE,
    },
    signal: options.signal,
  });
  return normalizeIssuePage(body);
}

/** Every loaded page flattened, dropping an issue a later page repeats (it moved while paging). */
export function flattenIssuePages(
  pages: readonly IssueListPage[] | undefined,
): IssueListItem[] {
  const seen = new Set<string>();
  const result: IssueListItem[] = [];
  for (const page of pages ?? []) {
    for (const issue of page.data) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      result.push(issue);
    }
  }
  return result;
}

/** Board groups with `hasMore` / `nextCursor`; an iteration 2 group without them is complete. */
export function normalizeBoardV3(body: unknown): BoardGroupV3[] {
  return normalizeBoardBody(body).map((group) => {
    const extra = group as BoardGroup & {
      hasMore?: unknown;
      nextCursor?: unknown;
    };
    const nextCursor = cursorOf(extra.nextCursor);
    return {
      statusKey: group.statusKey,
      issues: group.issues,
      nextCursor,
      hasMore: extra.hasMore === true || nextCursor !== null,
    };
  });
}

export async function fetchBoardV3(
  api: ApiClient,
  filters: IssueFilters,
  signal?: AbortSignal,
): Promise<BoardGroupV3[]> {
  const body = await api.request<unknown>({
    path: 'np/issues',
    query: { ...issueQuery(filters), view: 'board' },
    signal,
  });
  return normalizeBoardV3(body);
}

/**
 * The next cards of one column (`GET /np/issues?view=board&statusKey=&cursor=`). The answer is a board with that one
 * group, or a plain issue page; both are read.
 */
export function normalizeBoardColumn(
  body: unknown,
  statusKey: string,
): IssueListPage {
  const record = (body ?? {}) as { data?: unknown; groups?: unknown };
  const nested =
    record.data && !Array.isArray(record.data)
      ? (record.data as { groups?: unknown }).groups
      : undefined;
  if (Array.isArray(record.groups ?? nested)) {
    const group = normalizeBoardV3(body).find(
      (candidate) => candidate.statusKey === statusKey,
    );
    return group
      ? { data: group.issues, nextCursor: group.nextCursor }
      : { data: [], nextCursor: null };
  }
  return normalizeIssuePage(body);
}

export async function fetchBoardColumn(
  api: ApiClient,
  filters: IssueFilters,
  statusKey: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<IssueListPage> {
  const body = await api.request<unknown>({
    path: 'np/issues',
    query: { ...issueQuery(filters), view: 'board', statusKey, cursor },
    signal,
  });
  return normalizeBoardColumn(body, statusKey);
}

/** A column's first cards from the board plus every "load more" page, without repeats. */
export function mergeColumnPages(
  first: readonly IssueListItem[],
  more: readonly IssueListPage[],
): IssueListItem[] {
  return flattenIssuePages([{ data: first, nextCursor: null }, ...more]);
}

/** The ⌘K search: the first 20 matches by title or identifier. */
export async function searchIssues(
  api: ApiClient,
  q: string,
  signal?: AbortSignal,
): Promise<IssueListItem[]> {
  const page = await fetchIssuePage(api, { q }, { limit: 20, signal });
  return [...page.data];
}

// ---------- §D activities ----------

export function normalizeActivityPage(body: unknown): ActivityPage {
  if (Array.isArray(body)) {
    return { data: body as IssueActivity[], nextCursor: null };
  }
  const record = (body ?? {}) as { data?: unknown; nextCursor?: unknown };
  if (Array.isArray(record.data)) {
    return {
      data: record.data as IssueActivity[],
      nextCursor: cursorOf(record.nextCursor),
    };
  }
  if (record.data && typeof record.data === 'object') {
    return normalizeActivityPage(record.data);
  }
  return { data: [], nextCursor: null };
}

export async function fetchIssueActivities(
  api: ApiClient,
  issueId: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<ActivityPage> {
  const body = await api.request<unknown>({
    path: `np/issues/${id(issueId)}/activities`,
    query: { cursor, limit: ACTIVITY_PAGE_SIZE },
    signal,
  });
  return normalizeActivityPage(body);
}

// ---------- §C metrics ----------

export function metricValue(raw: MetricRaw | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw && typeof raw === 'object' && typeof raw.value === 'number') {
    return Number.isFinite(raw.value) ? raw.value : null;
  }
  return null;
}

export function metricDefinition(raw: MetricRaw | undefined): string | null {
  return raw && typeof raw === 'object' && typeof raw.definition === 'string'
    ? raw.definition
    : null;
}

/** The contract's defaults (§C), used when the report omits `thresholds`. */
export const DEFAULT_METRIC_THRESHOLDS: Required<
  Pick<
    MetricThresholds,
    | 'aiShare'
    | 'proposalAcceptRate'
    | 'claimLatencyP50Ms'
    | 'lostRuns'
    | 'decisionResolveP50Ms'
  >
> = {
  aiShare: 0.5,
  proposalAcceptRate: 0.7,
  claimLatencyP50Ms: 3000,
  lostRuns: 0,
  decisionResolveP50Ms: 24 * 60 * 60 * 1000,
};

/** Which way each thresholded metric is good: `min` means "at least", `max` "at most". */
const THRESHOLD_RULES: Readonly<
  Record<string, { readonly threshold: string; readonly rule: 'min' | 'max' }>
> = {
  share: { threshold: 'aiShare', rule: 'min' },
  proposalAcceptRate: { threshold: 'proposalAcceptRate', rule: 'min' },
  claimLatencyP50Ms: { threshold: 'claimLatencyP50Ms', rule: 'max' },
  lostRuns: { threshold: 'lostRuns', rule: 'max' },
  decisionResolveP50Ms: { threshold: 'decisionResolveP50Ms', rule: 'max' },
};

export function isThresholdedMetric(key: string): boolean {
  return key in THRESHOLD_RULES;
}

/** The threshold a metric is held to, or null when it has none. */
export function metricThreshold(
  key: string,
  thresholds: MetricThresholds,
): { readonly value: number; readonly rule: 'min' | 'max' } | null {
  const entry = THRESHOLD_RULES[key];
  if (!entry) return null;
  const value =
    thresholds[entry.threshold] ??
    (DEFAULT_METRIC_THRESHOLDS as Record<string, number>)[entry.threshold];
  return typeof value === 'number' ? { value, rule: entry.rule } : null;
}

/**
 * A metric's status: the server's when it sent one, else computed from the threshold. A metric without a threshold
 * or without a value is `n/a`.
 */
export function metricStatus(
  key: string,
  value: number | null,
  report: Pick<MetricsReport, 'thresholds' | 'statuses'>,
): MetricStatus {
  // The server keys statuses by threshold name (`aiShare` for the `share` metric).
  const fromServer =
    report.statuses[key] ??
    report.statuses[THRESHOLD_RULES[key]?.threshold ?? ''];
  if (fromServer === 'ok' || fromServer === 'warn' || fromServer === 'n/a') {
    return fromServer;
  }
  const threshold = metricThreshold(key, report.thresholds);
  if (!threshold || value === null) return 'n/a';
  const ok =
    threshold.rule === 'min'
      ? value >= threshold.value
      : value <= threshold.value;
  return ok ? 'ok' : 'warn';
}

function record<T>(value: unknown): T {
  return (value && typeof value === 'object' ? value : {}) as T;
}

/** Fills every group so a partial report still renders; missing values read as n/a. */
export function normalizeMetrics(body: unknown): MetricsReport {
  const raw = record<Partial<MetricsReport>>(unwrap<unknown>(body));
  const reliability = record<Partial<MetricsReport['reliability']>>(
    raw.reliability,
  );
  const cost = record<Partial<MetricsReport['cost']>>(raw.cost);
  const humanLoad = record<Partial<MetricsReport['humanLoad']>>(raw.humanLoad);
  return {
    from: raw.from,
    to: raw.to,
    projectId: raw.projectId ?? null,
    adoption: record(raw.adoption),
    aiShare: record(raw.aiShare),
    trust: record(raw.trust),
    reliability: {
      ...(reliability as MetricsReport['reliability']),
      failuresByReason: record(reliability.failuresByReason),
    },
    cost: {
      ...(cost as MetricsReport['cost']),
      byAgent: Array.isArray(cost.byAgent) ? cost.byAgent : [],
    },
    humanLoad: {
      ...(humanLoad as MetricsReport['humanLoad']),
      byType: record(humanLoad.byType),
    },
    thresholds: { ...DEFAULT_METRIC_THRESHOLDS, ...record(raw.thresholds) },
    statuses: record(raw.statuses),
  };
}

export async function fetchMetrics(
  api: ApiClient,
  query: MetricsQuery,
  signal?: AbortSignal,
): Promise<MetricsReport> {
  const body = await api.request<unknown>({
    path: 'np/metrics',
    query: {
      from: query.from,
      to: query.to,
      projectId: query.projectId || undefined,
    },
    signal,
  });
  return normalizeMetrics(body);
}

// ---------- §F workflows ----------

export async function fetchWorkflowList(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<WorkflowListItem[]> {
  return unwrapList<WorkflowListItem>(
    await api.request<unknown>({ path: 'np/workflows', signal }),
  );
}

export async function fetchWorkflowTemplate(
  api: ApiClient,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowListItem> {
  return unwrap<WorkflowListItem>(
    await api.request<unknown>({
      path: `np/workflows/${id(workflowId)}`,
      signal,
    }),
  );
}

// ---------- labels (config tab) ----------

export async function updateLabel(
  api: ApiClient,
  labelId: string,
  changes: { readonly name?: string; readonly color?: LabelColor },
): Promise<Label | null> {
  const body = await api.request<unknown, typeof changes>({
    path: `np/labels/${id(labelId)}`,
    method: 'PATCH',
    json: changes,
  });
  return unwrap<Label | null>(body) ?? null;
}

export async function deleteLabel(
  api: ApiClient,
  labelId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/labels/${id(labelId)}`,
    method: 'DELETE',
  });
}
