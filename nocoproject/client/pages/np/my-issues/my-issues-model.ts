import type { IssueFilterKey } from '../issues/filters.js';
import type { IssueFilters } from '../types.js';

export type MyIssuesRole = 'owned' | 'executing';

/**
 * The filters a "my issues" tab fixes (§G): I own is `ownerUserId = me`, I execute is `executorId = me` (a person
 * executing, not an agent). The fixed key is hidden from the toolbar; every other filter still comes from the URL.
 */
export function myIssueFilters(
  role: MyIssuesRole,
  userId: string,
): {
  readonly fixedFilters: Partial<IssueFilters>;
  readonly hiddenFilters: readonly IssueFilterKey[];
} {
  return role === 'owned'
    ? { fixedFilters: { ownerUserId: userId }, hiddenFilters: ['ownerUserId'] }
    : { fixedFilters: { executorId: userId }, hiddenFilters: ['executorId'] };
}
