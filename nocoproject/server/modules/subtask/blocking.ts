/**
 * Blocking (docs/phase1/iteration-1-contract.md §D): an issue is blocked when
 *
 * - a `blockedBy` dependency points at an issue that has not reached a terminal status, or
 * - it has a `stage` and a sibling under the same parent has a smaller stage and is not terminal.
 *
 * Terminal is decided by each blocker's own workflow (done | closed categories).
 */
import type { Conn } from '../shared/db.js';
import { num, str, unique } from '../shared/db.js';
import type { Blocker, IssueV1, IssueV4 } from '../shared/protocol.js';
import { issuesByIds, mapIssue } from '../issue/issue.records.js';
import type { WorkflowService } from '../workflow/workflow.service.js';

async function isTerminal(
  conn: Conn,
  workflows: WorkflowService,
  issue: IssueV1,
): Promise<boolean> {
  return (await workflows.forIssue(conn, issue)).isTerminal(issue.statusKey);
}

function blocker(issue: IssueV1, reason: Blocker['reason']): Blocker {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    statusKey: issue.statusKey,
    reason,
  };
}

/** Children of a parent, oldest first. */
export async function childrenOf(
  conn: Conn,
  parentIssueId: string,
): Promise<IssueV4[]> {
  const rows = await conn.query
    .selectFrom('issues')
    .selectAll()
    .where('parentIssueId', '=', parentIssueId)
    .where('deletedAt', 'is', null)
    .orderBy('number', 'asc')
    .execute();
  return rows.map(mapIssue);
}

/** What currently blocks `issue` (empty = not blocked). */
export async function blockersOf(
  conn: Conn,
  workflows: WorkflowService,
  issue: IssueV1,
): Promise<Blocker[]> {
  const result: Blocker[] = [];
  const dependencies = await conn.query
    .selectFrom('issueDependencies')
    .select('dependsOnIssueId')
    .where('issueId', '=', issue.id)
    .where('type', '=', 'blockedBy')
    .execute();
  const targets = await issuesByIds(
    conn,
    dependencies.map((row) => str(row.dependsOnIssueId)),
  );
  for (const target of targets.values()) {
    if (!(await isTerminal(conn, workflows, target)))
      result.push(blocker(target, 'dependency'));
  }
  if (issue.parentIssueId && issue.stage !== null) {
    const siblings = await conn.query
      .selectFrom('issues')
      .selectAll()
      .where('parentIssueId', '=', issue.parentIssueId)
      .where('stage', '<', issue.stage)
      .where('deletedAt', 'is', null)
      .orderBy('stage', 'asc')
      .orderBy('number', 'asc')
      .execute();
    for (const sibling of siblings.map(mapIssue)) {
      if (!(await isTerminal(conn, workflows, sibling)))
        result.push(blocker(sibling, 'stage'));
    }
  }
  return result;
}

/** Blocker counts for several issues (lists, subtask summaries). */
export async function blockedCounts(
  conn: Conn,
  workflows: WorkflowService,
  issues: readonly IssueV1[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (issues.length === 0) return counts;
  const dependencies = await conn.query
    .selectFrom('issueDependencies')
    .select(['issueId', 'dependsOnIssueId'])
    .where(
      'issueId',
      'in',
      issues.map((issue) => issue.id),
    )
    .where('type', '=', 'blockedBy')
    .execute();
  const parents = unique(
    issues
      .filter((issue) => issue.stage !== null)
      .map((issue) => issue.parentIssueId),
  );
  const siblingRows = parents.length
    ? await conn.query
        .selectFrom('issues')
        .selectAll()
        .where('parentIssueId', 'in', parents)
        .where('stage', 'is not', null)
        .where('deletedAt', 'is', null)
        .execute()
    : [];
  const siblings = siblingRows.map(mapIssue);
  const targets = await issuesByIds(
    conn,
    dependencies.map((row) => str(row.dependsOnIssueId)),
  );
  const open = new Set<string>();
  for (const candidate of [...targets.values(), ...siblings]) {
    if (!(await isTerminal(conn, workflows, candidate))) open.add(candidate.id);
  }
  for (const row of dependencies) {
    const issueId = str(row.issueId) ?? '';
    if (open.has(str(row.dependsOnIssueId) ?? ''))
      counts.set(issueId, (counts.get(issueId) ?? 0) + 1);
  }
  for (const issue of issues) {
    if (issue.stage === null || !issue.parentIssueId) continue;
    const stage = issue.stage;
    const earlier = siblings.filter(
      (sibling) =>
        sibling.parentIssueId === issue.parentIssueId &&
        sibling.stage !== null &&
        num(sibling.stage) < stage &&
        open.has(sibling.id),
    ).length;
    if (earlier > 0)
      counts.set(issue.id, (counts.get(issue.id) ?? 0) + earlier);
  }
  return counts;
}
