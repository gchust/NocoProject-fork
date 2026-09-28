/**
 * The browser issue list and board (docs/phase1/iteration-3-contract.md §D): keyset pages in the fixed order
 * `updatedAt desc, id desc` (`sort=created`: `createdAt desc, id desc`), filtered to what the caller may see.
 *
 * - list: `limit` (default 50, at most 100) and an opaque `cursor`; `nextCursor` is null on the last page.
 * - board: one page per status column (`columnLimit`, default 50) with `hasMore` / `nextCursor`; with `statusKey`
 *   only that column. Columns are the workflow's catalog plus any other status a visible issue is in.
 *
 * Cursors carry millisecond timestamps, which is what the application writes.
 */
import type { Viewer } from '../shared/authz.js';
import { hiddenProjectIds } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { iso, num, str, unique } from '../shared/db.js';
import { decodeCursor, encodeCursor, pageLimit } from '../shared/pagination.js';
import type {
  BoardGroupV3Server,
  IssueListItemV4,
  IssueListPageV3,
  IssueV4,
} from '../shared/protocol.js';
import {
  BOARD_COLUMN_DEFAULT_LIMIT,
  ISSUE_PAGE_DEFAULT_LIMIT,
  ISSUE_PAGE_MAX_LIMIT,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { labelsForIssues } from '../label/label.service.js';
import { activeRunCounts, agentNames } from '../run/run.queries.js';
import { blockedCounts } from '../subtask/blocking.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import { mapIssue } from './issue.records.js';

export interface IssueListFilter {
  readonly statusKey?: string | null;
  readonly projectId?: string | null;
  readonly q?: string | null;
  readonly labelId?: string | null;
  readonly ownerUserId?: string | null;
  readonly executorId?: string | null;
  /** An issue id, or `none` for top-level issues only. */
  readonly parentIssueId?: string | null;
  /** Iteration 4 (`/np/agent/pm/issues`): only issues updated at or after this instant. */
  readonly updatedSince?: Date | null;
}

export interface IssuePageOptions {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  /** `created` = newest created first; default = most recently updated first. */
  readonly sort?: string | null;
}

export interface BoardOptions {
  readonly cursor?: string | null;
  readonly columnLimit?: number | null;
}

export interface ListDeps {
  readonly users: UserDirectory;
  readonly workflows: WorkflowService;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

/** Display names, counts and labels for list rows (a fixed number of queries whatever the page size). */
export async function withNames(
  deps: ListDeps,
  conn: Conn,
  issues: readonly IssueV4[],
): Promise<IssueListItemV4[]> {
  const userNames = await deps.users.names(conn, [
    ...issues.map((issue) => issue.ownerUserId),
    ...issues
      .filter((issue) => issue.executorType === 'user')
      .map((issue) => issue.executorId),
  ]);
  const agents = await agentNames(
    conn,
    issues
      .filter((issue) => issue.executorType === 'agent')
      .map((issue) => issue.executorId),
  );
  const ids = issues.map((issue) => issue.id);
  const counts = await activeRunCounts(conn, 'subjectId', ids);
  const labels = await labelsForIssues(conn, ids);
  const blocked = await blockedCounts(conn, deps.workflows, issues);
  const projectIds = unique(issues.map((issue) => issue.projectId));
  const projects = projectIds.length
    ? await conn.query
        .selectFrom('projects')
        .select(['id', 'name'])
        .where('id', 'in', projectIds)
        .execute()
    : [];
  const projectNames = new Map(
    projects.map((row) => [str(row.id) ?? '', str(row.name) ?? '']),
  );
  const children = ids.length
    ? await conn.query
        .selectFrom('issues')
        .select((eb) => ['parentIssueId', eb.fn.countAll().as('count')])
        .where('parentIssueId', 'in', ids)
        .where('deletedAt', 'is', null)
        .groupBy('parentIssueId')
        .execute()
    : [];
  const childCounts = new Map(
    children.map((row) => [str(row.parentIssueId) ?? '', num(row.count)]),
  );
  return issues.map((issue) => ({
    ...issue,
    ownerName: issue.ownerUserId
      ? (userNames.get(issue.ownerUserId) ?? null)
      : null,
    executorName:
      issue.executorType === 'agent'
        ? (agents.get(issue.executorId ?? '') ?? null)
        : issue.executorType === 'user'
          ? (userNames.get(issue.executorId ?? '') ?? null)
          : null,
    activeRunCount: counts.get(issue.id) ?? 0,
    labels: labels.get(issue.id) ?? [],
    projectName: issue.projectId
      ? (projectNames.get(issue.projectId) ?? null)
      : null,
    subtaskCount: childCounts.get(issue.id) ?? 0,
    blockedCount: blocked.get(issue.id) ?? 0,
  }));
}

/** The filtered, visible issues as a query (null when the label filter matches nothing). */
async function filteredQuery(
  conn: Conn,
  viewer: Viewer,
  filter: IssueListFilter,
) {
  const hidden = await hiddenProjectIds(conn, viewer);
  let query = conn.query
    .selectFrom('issues')
    .selectAll()
    .where('deletedAt', 'is', null);
  if (hidden.length > 0)
    query = query.where((eb) =>
      eb.or([eb('projectId', 'is', null), eb('projectId', 'not in', hidden)]),
    );
  // Iteration 4: project manager conversations are private to their owner.
  query = query.where((eb) =>
    eb.or([
      eb('originType', '!=', 'pm'),
      eb('ownerUserId', '=', viewer.userId),
    ]),
  );
  if (filter.updatedSince)
    query = query.where('updatedAt', '>=', filter.updatedSince);
  if (filter.statusKey) query = query.where('statusKey', '=', filter.statusKey);
  if (filter.projectId) query = query.where('projectId', '=', filter.projectId);
  if (filter.ownerUserId)
    query = query.where('ownerUserId', '=', filter.ownerUserId);
  if (filter.executorId)
    query = query.where('executorId', '=', filter.executorId);
  if (filter.parentIssueId === 'none')
    query = query.where('parentIssueId', 'is', null);
  else if (filter.parentIssueId)
    query = query.where('parentIssueId', '=', filter.parentIssueId);
  if (filter.labelId) {
    const linked = await conn.query
      .selectFrom('issueLabelLinks')
      .select('issueId')
      .where('labelId', '=', filter.labelId)
      .execute();
    const ids = unique(linked.map((row) => str(row.issueId)));
    if (ids.length === 0) return null;
    query = query.where('id', 'in', ids);
  }
  const q = filter.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    query = query.where((eb) =>
      eb.or([eb('title', 'like', pattern), eb('identifier', 'like', pattern)]),
    );
  }
  return query;
}

interface RawPage {
  readonly issues: IssueV4[];
  readonly nextCursor: string | null;
}

async function rawPage(
  conn: Conn,
  viewer: Viewer,
  filter: IssueListFilter,
  options: IssuePageOptions,
  limit: number,
): Promise<RawPage> {
  const base = await filteredQuery(conn, viewer, filter);
  if (!base) return { issues: [], nextCursor: null };
  const column = options.sort === 'created' ? 'createdAt' : 'updatedAt';
  let query = base;
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    query = query.where((eb) =>
      eb.or([
        eb(column, '<', cursor.at),
        eb.and([eb(column, '=', cursor.at), eb('id', '<', cursor.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy(column, 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();
  const issues = rows.slice(0, limit).map(mapIssue);
  const last = issues[issues.length - 1];
  return {
    issues,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(iso(last[column]), last.id)
        : null,
  };
}

export async function issuePage(
  deps: ListDeps,
  conn: Conn,
  viewer: Viewer,
  filter: IssueListFilter,
  options: IssuePageOptions,
): Promise<IssueListPageV3> {
  const limit = pageLimit(
    options.limit,
    ISSUE_PAGE_DEFAULT_LIMIT,
    ISSUE_PAGE_MAX_LIMIT,
  );
  const page = await rawPage(conn, viewer, filter, options, limit);
  return {
    data: await withNames(deps, conn, page.issues),
    nextCursor: page.nextCursor,
  };
}

/** Every issue of the list in order, up to `max` (internal callers and iteration 1–2 tests). */
export async function issueList(
  deps: ListDeps,
  conn: Conn,
  viewer: Viewer,
  filter: IssueListFilter,
  max: number,
): Promise<IssueListItemV4[]> {
  const page = await rawPage(conn, viewer, filter, {}, max);
  return withNames(deps, conn, page.issues);
}

async function columnKeys(
  deps: ListDeps,
  conn: Conn,
  viewer: Viewer,
  filter: IssueListFilter,
): Promise<string[]> {
  const view = await deps.workflows.forProject(conn, filter.projectId ?? null);
  const keys = view.catalog.map((entry) => entry.key);
  const base = await filteredQuery(conn, viewer, filter);
  if (!base) return keys;
  const used = await base
    .clearSelect()
    .select('statusKey')
    .groupBy('statusKey')
    .execute();
  for (const row of used) {
    const key = str(row.statusKey);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export async function issueBoard(
  deps: ListDeps,
  conn: Conn,
  viewer: Viewer,
  filter: IssueListFilter,
  options: BoardOptions,
): Promise<{ groups: BoardGroupV3Server[] }> {
  const limit = pageLimit(
    options.columnLimit,
    BOARD_COLUMN_DEFAULT_LIMIT,
    ISSUE_PAGE_MAX_LIMIT,
  );
  // With statusKey: that column only (the "load more" of one column), continuing from `cursor`.
  const keys = filter.statusKey
    ? [filter.statusKey]
    : await columnKeys(deps, conn, viewer, filter);
  const pages: { statusKey: string; page: RawPage }[] = [];
  for (const statusKey of keys)
    pages.push({
      statusKey,
      page: await rawPage(
        conn,
        viewer,
        { ...filter, statusKey },
        { cursor: filter.statusKey ? options.cursor : null },
        limit,
      ),
    });
  const named = await withNames(
    deps,
    conn,
    pages.flatMap((entry) => entry.page.issues),
  );
  const byId = new Map(named.map((item) => [item.id, item]));
  return {
    groups: pages.map(({ statusKey, page }) => ({
      statusKey,
      issues: page.issues
        .map((issue) => byId.get(issue.id))
        .filter((item): item is IssueListItemV4 => item !== undefined),
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor,
    })),
  };
}
