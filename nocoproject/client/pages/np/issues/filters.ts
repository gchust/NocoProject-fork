import type { IssueFilters } from '../types.js';

/**
 * The issue list and board keep their view and filters in the query string (§J 1, 7), so a refresh, going back or a
 * shared link restores them. These are the parameter names; the values are the ids the API filters by.
 */
export type IssueView = 'list' | 'board';

export const ISSUE_FILTER_PARAMS = {
  q: 'q',
  statusKey: 'status',
  projectId: 'project',
  labelId: 'label',
  ownerUserId: 'owner',
  executorId: 'executor',
} as const satisfies Partial<Record<keyof IssueFilters, string>>;

export type IssueFilterKey = keyof typeof ISSUE_FILTER_PARAMS;

export function readIssueView(params: URLSearchParams): IssueView {
  return params.get('view') === 'board' ? 'board' : 'list';
}

/**
 * The view to show (nocosolution/NocoSolution 前端规范.md §8): `?view=` when the URL names one, else the person's last choice
 * on this page, else the board.
 */
export function resolveIssueView(
  params: URLSearchParams,
  stored: IssueView | null,
): IssueView {
  const value = params.get('view');
  if (value === 'board' || value === 'list') return value;
  return stored ?? 'board';
}

const VIEW_STORAGE_PREFIX = 'nocoproject:issues-view:';

/** The last view chosen on `page` (`issues`, `my-issues`), or null when none is saved or storage is unavailable. */
export function readStoredIssueView(page: string): IssueView | null {
  try {
    const value = window.localStorage.getItem(VIEW_STORAGE_PREFIX + page);
    return value === 'board' || value === 'list' ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the view for `page`; a private window or blocked storage just forgets it. */
export function storeIssueView(page: string, view: IssueView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_PREFIX + page, view);
  } catch {
    // The choice is a convenience; the URL still carries it for this visit.
  }
}

/**
 * Filters from the query string. The search term is trimmed for the request; an unknown status is dropped, and the
 * status filter does not apply to the board, whose columns are the statuses.
 */
export function readIssueFilters(
  params: URLSearchParams,
  knownStatusKeys: ReadonlySet<string>,
  view: IssueView = readIssueView(params),
): IssueFilters {
  const value = (key: IssueFilterKey): string | undefined =>
    params.get(ISSUE_FILTER_PARAMS[key])?.trim() || undefined;
  const status = value('statusKey');
  return {
    q: value('q'),
    statusKey:
      view === 'list' && status && knownStatusKeys.has(status)
        ? status
        : undefined,
    projectId: value('projectId'),
    labelId: value('labelId'),
    ownerUserId: value('ownerUserId'),
    executorId: value('executorId'),
  };
}

/** A copy of `params` with one filter set, or removed when `value` is empty. */
export function withIssueFilter(
  params: URLSearchParams,
  key: IssueFilterKey,
  value: string | null | undefined,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value) next.set(ISSUE_FILTER_PARAMS[key], value);
  else next.delete(ISSUE_FILTER_PARAMS[key]);
  return next;
}

export function withIssueView(
  params: URLSearchParams,
  view: IssueView,
): URLSearchParams {
  // Always explicit: without `view` the page falls back to the remembered choice, which may be the other one.
  const next = new URLSearchParams(params);
  next.set('view', view);
  return next;
}

/** A copy of `params` without any filter, keeping the view. */
export function withoutIssueFilters(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of Object.values(ISSUE_FILTER_PARAMS)) next.delete(name);
  return next;
}

export function hasIssueFilters(filters: IssueFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined);
}
