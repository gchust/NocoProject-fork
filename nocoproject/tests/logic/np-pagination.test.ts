// @vitest-environment node
/**
 * Paginated lists (iteration-3 contract §D, §F) on a real PostgreSQL through the real route factories: the issue list
 * cursor (order, tie-break by id, `sort=created`, limits, filters, private projects), board columns with `hasMore`
 * and one-column paging, the detail's latest 50 activities / latest 200 comments with cursors for older pages, and
 * the workflow list's `projectCount`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type {
  ActivityPage,
  BoardGroupV3,
  CommentPage,
  IssueDetailV3,
  IssueListPage,
  WorkflowListItem,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  CAROL,
  buildServices,
  openNpTestDatabase,
  resetData,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';
import { browserApi, insertIssues, type ApiCall } from './np-iter3-harness.ts';

const opened = await openNpTestDatabase('np_t_pagination');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-pagination] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let alice: ApiCall;
let carol: ApiCall;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, CAROL, 'member');
  alice = browserApi(services, ALICE);
  carol = browserApi(services, CAROL);
});

type Row = { id: string; statusKey: string; updatedAt: string };

async function walk(api: ApiCall, query: string): Promise<Row[]> {
  const seen: Row[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const separator = query ? '&' : '';
    const response: { status: number; body: IssueListPage<Row> } = await api<
      IssueListPage<Row>
    >(
      'GET',
      `/np/issues?${query}${separator}${cursor ? `cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(response.status).toBe(200);
    seen.push(...response.body.data);
    cursor = response.body.nextCursor;
    if (!cursor) return seen;
  }
  throw new Error('too many pages');
}

describe.skipIf(!db)('issue list and board pagination (PostgreSQL)', () => {
  it('pages the list by cursor in updatedAt desc, id desc order without gaps', async () => {
    const ids = await insertIssues(db!, { count: 130, tieEvery: 5 });
    const first = await alice<IssueListPage<Row>>('GET', '/np/issues');
    expect(first.body.data).toHaveLength(50);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const all = await walk(alice, 'limit=37');
    expect(all).toHaveLength(130);
    expect(new Set(all.map((row) => row.id)).size).toBe(130);
    const expected = [...all].sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? b.id.localeCompare(a.id)
        : b.updatedAt.localeCompare(a.updatedAt),
    );
    expect(all.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(new Set(all.map((row) => row.id))).toEqual(new Set(ids));
    // Ties exist, and they are broken by id.
    expect(new Set(all.map((row) => row.updatedAt)).size).toBeLessThan(130);

    const created = await walk(alice, 'sort=created&limit=100');
    expect(created).toHaveLength(130);
    const huge = await alice<IssueListPage<Row>>('GET', '/np/issues?limit=500');
    expect(huge.body.data).toHaveLength(100);
    expect((await alice('GET', '/np/issues?limit=abc')).body.code).toBe(
      'INVALID_QUERY',
    );
    expect((await alice('GET', '/np/issues?cursor=nope')).body.code).toBe(
      'INVALID_CURSOR',
    );
  });

  it('pages within filters and leaves private projects out', async () => {
    const open = (await services.projects.create(ALICE, { name: 'Open' })).id;
    const secret = (
      await services.projects.create(ALICE, {
        name: 'Secret',
        visibility: 'members',
      })
    ).id;
    await insertIssues(db!, {
      count: 60,
      prefix: 'op',
      projectId: open,
      statusKeys: ['todo', 'in_progress', 'done'],
    });
    await insertIssues(db!, { count: 15, prefix: 'se', projectId: secret });
    expect(
      await walk(carol, `projectId=${open}&statusKey=todo&limit=7`),
    ).toHaveLength(20);
    expect(await walk(carol, 'limit=40')).toHaveLength(60);
    expect(await walk(alice, 'limit=40')).toHaveLength(75);
    const search = await walk(carol, 'q=Issue%201&limit=5');
    expect(search.every((row) => row.id.startsWith('op-'))).toBe(true);
  });

  it('pages board columns and loads more of one column', async () => {
    await insertIssues(db!, {
      count: 90,
      statusKeys: ['todo', 'todo', 'in_progress'],
    });
    const board = await alice<{ data: { groups: BoardGroupV3<Row>[] } }>(
      'GET',
      '/np/issues?view=board&columnLimit=25',
    );
    const groups = board.body.data.groups;
    expect(groups.map((group) => group.statusKey)).toEqual(
      expect.arrayContaining(['backlog', 'todo', 'in_progress', 'done']),
    );
    const todo = groups.find((group) => group.statusKey === 'todo')!;
    expect(todo.issues).toHaveLength(25);
    expect(todo.hasMore).toBe(true);
    const done = groups.find((group) => group.statusKey === 'done')!;
    expect(done).toMatchObject({
      issues: [],
      hasMore: false,
      nextCursor: null,
    });
    const column: Row[] = [...todo.issues];
    let cursor = todo.nextCursor;
    while (cursor) {
      const more = await alice<{ data: { groups: BoardGroupV3<Row>[] } }>(
        'GET',
        `/np/issues?view=board&statusKey=todo&columnLimit=25&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(more.body.data.groups).toHaveLength(1);
      column.push(...more.body.data.groups[0]!.issues);
      cursor = more.body.data.groups[0]!.nextCursor;
    }
    expect(column).toHaveLength(60);
    expect(new Set(column.map((row) => row.id)).size).toBe(60);
    expect(column.every((row) => row.statusKey === 'todo')).toBe(true);
    const defaults = await alice<{ data: { groups: BoardGroupV3<Row>[] } }>(
      'GET',
      '/np/issues?view=board',
    );
    expect(
      defaults.body.data.groups.find((group) => group.statusKey === 'todo')
        ?.issues,
    ).toHaveLength(50);
  });
});

describe.skipIf(!db)(
  'detail timeline pages and workflow usage (PostgreSQL)',
  () => {
    it('returns the latest 50 activities and 200 comments with cursors for older pages', async () => {
      const issue = await services.issues.create(ALICE, { title: 'Busy' });
      // After the issue_created activity, so that one is the oldest item.
      const base = Date.now() + 60_000;
      const activities = Array.from({ length: 79 }, (_, index) => ({
        id: `act-${String(index).padStart(4, '0')}`,
        issue_id: issue.id,
        actor_type: 'user',
        actor_id: ALICE.id,
        action: 'title_changed',
        details: JSON.stringify({ n: index }),
        created_at: new Date(base + index * 1000),
      }));
      await db!.knex
        .withSchema(db!.schema)
        .table('activities')
        .insert(activities);
      const comments = Array.from({ length: 205 }, (_, index) => ({
        id: `com-${String(index).padStart(4, '0')}`,
        issue_id: issue.id,
        author_type: 'user',
        author_id: ALICE.id,
        content: `comment ${index}`,
        kind: 'comment',
        root_id: `com-${String(index).padStart(4, '0')}`,
        created_at: new Date(base + index * 1000),
        updated_at: new Date(base + index * 1000),
      }));
      await db!.knex.withSchema(db!.schema).table('comments').insert(comments);

      const detail = await alice<{ data: IssueDetailV3 }>(
        'GET',
        `/np/issues/${issue.id}`,
      );
      const data = detail.body.data;
      expect(data.activities).toHaveLength(50);
      expect(data.activities.at(-1)?.id).toBe('act-0078');
      expect(data.activities[0]?.id).toBe('act-0029');
      expect(data.activitiesNextCursor).toEqual(expect.any(String));
      expect(data.comments).toHaveLength(200);
      expect(data.comments[0]?.id).toBe('com-0005');
      expect(data.commentsNextCursor).toEqual(expect.any(String));

      const older = await alice<ActivityPage>(
        'GET',
        `/np/issues/${issue.identifier}/activities?cursor=${encodeURIComponent(data.activitiesNextCursor!)}&limit=20`,
      );
      expect(older.body.data.map((item) => item.id)).toEqual(
        Array.from(
          { length: 20 },
          (_, index) => `act-${String(index + 9).padStart(4, '0')}`,
        ),
      );
      const rest = await alice<ActivityPage>(
        'GET',
        `/np/issues/${issue.id}/activities?cursor=${encodeURIComponent(older.body.nextCursor!)}`,
      );
      // The last page: issue_created and (iteration 4) process_selected, then act-0000 … act-0008.
      expect(rest.body.data).toHaveLength(11);
      expect(rest.body.data[0]?.action).toBe('issue_created');
      expect(rest.body.data[1]?.action).toBe('process_selected');
      const allIds = [
        ...rest.body.data,
        ...older.body.data,
        ...data.activities,
      ].map((item) => item.id);
      expect(new Set(allIds).size).toBe(81);
      expect(rest.body.nextCursor).toBeNull();

      const olderComments = await alice<CommentPage>(
        'GET',
        `/np/issues/${issue.id}/comments?cursor=${encodeURIComponent(data.commentsNextCursor!)}`,
      );
      expect(olderComments.body.data.map((item) => item.id)).toEqual([
        'com-0000',
        'com-0001',
        'com-0002',
        'com-0003',
        'com-0004',
      ]);
      expect(olderComments.body.nextCursor).toBeNull();
      // A member who cannot see the issue gets 404 on its pages too.
      const secret = await services.projects.create(ALICE, {
        name: 'Secret',
        visibility: 'members',
      });
      const hidden = await services.issues.create(ALICE, {
        title: 'Hidden',
        projectId: secret.id,
      });
      expect(
        (await carol('GET', `/np/issues/${hidden.id}/activities`)).status,
      ).toBe(404);
    });

    it('counts the projects on each workflow template', async () => {
      await services.projects.create(ALICE, { name: 'A' });
      const gated = await services.projects.create(ALICE, { name: 'B' });
      await services.projects.update(ALICE, gated.id, {
        workflowId: 'software-with-approval',
      });
      const list = await alice<{ data: WorkflowListItem[] }>(
        'GET',
        '/np/workflows',
      );
      expect(
        list.body.data.map((item) => [
          item.id,
          item.isDefault,
          item.projectCount,
        ]),
      ).toEqual([
        ['default', true, 1],
        ['software-with-approval', false, 1],
      ]);
      const one = await alice<{ data: WorkflowListItem }>(
        'GET',
        '/np/workflows/software-with-approval',
      );
      expect(one.body.data.projectCount).toBe(1);
      expect(one.body.data.definition.transitions.length).toBeGreaterThan(0);
    });
  },
);
