/**
 * The unified "new issue" dialog (iteration 4 §D) as data: which tab opens, where it goes when it closes, and where
 * the old batch-entry links now land.
 */

export type NewIssueTab = 'ai' | 'manual';

export const NEW_ISSUE_TABS: readonly NewIssueTab[] = ['ai', 'manual'];

const TAB_STORAGE_KEY = 'nocoproject:new-issue-tab';

function readTab(value: string | null): NewIssueTab | null {
  return NEW_ISSUE_TABS.find((tab) => tab === value) ?? null;
}

/** The last tab the person used, or null when none is saved or storage is unavailable. */
export function readStoredNewIssueTab(): NewIssueTab | null {
  try {
    return readTab(window.localStorage.getItem(TAB_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Remembers the tab; a private window or blocked storage just forgets it. */
export function storeNewIssueTab(tab: NewIssueTab): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // A convenience only: the URL carries the tab for this visit.
  }
}

/**
 * The tab to show: `?tab=` when the URL names one (links from batch entry and "AI 拆解" say `ai`), a draft batch in
 * `?batch=` (always the AI tab), else the person's last tab, else AI 整理.
 */
export function resolveNewIssueTab(
  params: URLSearchParams,
  stored: NewIssueTab | null,
): NewIssueTab {
  const named = readTab(params.get('tab'));
  if (named) return named;
  if (params.get('batch')) return 'ai';
  return stored ?? 'ai';
}

/** The query string to return to on close: the list's own filters (the project stays), without the dialog's. */
export function newIssueCloseSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('tab');
  params.delete('batch');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Where an old batch-entry link goes (`/intake`, `/issues/intake`, `/projects/:projectId/intake`): the dialog's AI
 * tab over the issue list, the project preselected, keeping `?batch=`.
 */
export function newIssueRedirectTarget(
  search: string,
  projectId?: string | null,
): string {
  const params = new URLSearchParams(search);
  const next = new URLSearchParams();
  next.set('tab', 'ai');
  const project = projectId ?? params.get('project');
  if (project) next.set('project', project);
  const batch = params.get('batch');
  if (batch) next.set('batch', batch);
  return `/issues/new?${next.toString()}`;
}
