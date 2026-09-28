/**
 * The `merge` action of unresolved `pr_review` cards (NP-85): offered only to a recipient who may merge
 * (`canMergePullRequest`), greyed out with the reason the stored snapshot gives. The confirm dialog asks GitHub again
 * before anything is merged, so a stale reason here is harmless.
 */
import { canMergePullRequest, viewerOf } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { str, unique } from '../shared/db.js';
import type { IssueV4 } from '../shared/protocol.js';
import { mapPullRequest } from '../git/git.records.js';
import { mergeBlockerOf } from '../git/merge-rules.js';
import type { MergeActionSource } from './inbox.actions.js';

function pullRequestIdOf(row: Record<string, unknown>): string | null {
  const payload = row.payload as { pullRequestId?: unknown } | null;
  return typeof payload?.pullRequestId === 'string' && payload.pullRequestId
    ? payload.pullRequestId
    : null;
}

/** Merge action sources by inbox item id (`payload` already parsed). */
export async function mergeActionSources(
  conn: Conn,
  rows: readonly Record<string, unknown>[],
  issues: ReadonlyMap<string, IssueV4>,
): Promise<Map<string, MergeActionSource>> {
  const result = new Map<string, MergeActionSource>();
  const candidates = rows.filter(
    (row) =>
      row.type === 'pr_review' &&
      !row.resolvedAt &&
      pullRequestIdOf(row) &&
      issues.has(str(row.issueId) ?? ''),
  );
  if (candidates.length === 0) return result;
  const prRows = await conn.query
    .selectFrom('pullRequests')
    .selectAll()
    .where('id', 'in', unique(candidates.map(pullRequestIdOf)))
    .execute();
  const prs = new Map(prRows.map((row) => [str(row.id) ?? '', row]));
  for (const row of candidates) {
    const pr = prs.get(pullRequestIdOf(row) ?? '');
    const issue = issues.get(str(row.issueId) ?? '');
    const userId = str(row.userId);
    if (!pr || !issue || !userId) continue;
    const viewer = await viewerOf(conn, { type: 'user', id: userId });
    if (!(await canMergePullRequest(conn, viewer, issue))) continue;
    result.set(str(row.id) ?? '', {
      pullRequestId: str(pr.id) ?? '',
      disabledReason: mergeBlockerOf(mapPullRequest(pr)),
    });
  }
  return result;
}
