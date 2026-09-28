// @vitest-environment node
/**
 * Large-fixture performance check (iteration-3 contract §D) on a real PostgreSQL: 2000 issues, 200 sub-issues,
 * 5000 activities (3000 on one issue) and 300 comments. The list, board and detail requests go through the real
 * route factories; each is measured as the median of three runs after a warm-up and logged. The contract's target is
 * 300 ms on a developer machine; the assertion allows 1000 ms so a loaded CI machine does not fail it. A full cursor
 * walk over the list must visit every visible issue exactly once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type {
  BoardGroupV3,
  IssueDetailV3,
  IssueListPage,
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

const BUDGET_MS = 1000;
const TARGET_MS = 300;

const opened = await openNpTestDatabase('np_t_perf');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-perf] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let alice: ApiCall;
let carol: ApiCall;
let projectId: string;
let hotIssueId: string;
const timings: Record<string, number> = {};

async function insertBulk(
  table: string,
  records: Record<string, unknown>[],
): Promise<void> {
  for (let index = 0; index < records.length; index += 1000)
    await db!.knex
      .withSchema(db!.schema)
      .table(table)
      .insert(records.slice(index, index + 1000));
}

beforeAll(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, CAROL, 'member');
  alice = browserApi(services, ALICE);
  carol = browserApi(services, CAROL);
  projectId = (await services.projects.create(ALICE, { name: 'Big' })).id;
  const secret = (
    await services.projects.create(ALICE, {
      name: 'Secret',
      visibility: 'members',
    })
  ).id;
  const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
  const main = await insertIssues(db, {
    count: 1500,
    prefix: 'pa',
    projectId,
    statusKeys: statuses,
    stepMs: 7000,
  });
  await insertIssues(db, {
    count: 300,
    prefix: 'pb',
    statusKeys: statuses,
    start: new Date('2026-09-10T00:00:00.000Z'),
  });
  await insertIssues(db, {
    count: 200,
    prefix: 'pc',
    projectId: secret,
    statusKeys: statuses,
    start: new Date('2026-09-05T00:00:00.000Z'),
  });
  for (let parent = 0; parent < 10; parent += 1)
    await insertIssues(db, {
      count: 20,
      prefix: `sub${parent}`,
      projectId,
      parentIssueId: main[parent],
      statusKeys: ['todo', 'done'],
      start: new Date('2026-09-01T00:00:00.000Z'),
    });
  hotIssueId = main[0]!;
  const base = Date.parse('2026-09-15T00:00:00.000Z');
  await insertBulk(
    'activities',
    Array.from({ length: 5000 }, (_, index) => ({
      id: `pact-${String(index).padStart(5, '0')}`,
      issue_id: index < 3000 ? hotIssueId : main[(index % 1400) + 50],
      actor_type: 'user',
      actor_id: ALICE.id,
      action: 'title_changed',
      details: JSON.stringify({ n: index }),
      created_at: new Date(base + index * 1000),
    })),
  );
  await insertBulk(
    'comments',
    Array.from({ length: 300 }, (_, index) => ({
      id: `pcom-${String(index).padStart(4, '0')}`,
      issue_id: hotIssueId,
      author_type: 'user',
      author_id: ALICE.id,
      content: `comment ${index}`,
      kind: 'comment',
      root_id: `pcom-${String(index).padStart(4, '0')}`,
      created_at: new Date(base + index * 1000),
      updated_at: new Date(base + index * 1000),
    })),
  );
  await db.knex.raw(`ANALYZE "${db.schema}".issues`);
  await db.knex.raw(`ANALYZE "${db.schema}".activities`);
}, 120_000);

/** Median of three timed calls after one warm-up; the request must succeed. */
async function measure(
  name: string,
  api: ApiCall,
  path: string,
): Promise<number> {
  expect((await api('GET', path)).status).toBe(200);
  const samples: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    const response = await api('GET', path);
    samples.push(performance.now() - started);
    expect(response.status).toBe(200);
  }
  const median = [...samples].sort((a, b) => a - b)[1]!;
  timings[name] = Math.round(median);
  return median;
}

describe.skipIf(!db)('large fixture (PostgreSQL)', () => {
  it('serves list, board and detail within the budget', async () => {
    const cases: [string, ApiCall, string][] = [
      ['list', alice, '/np/issues'],
      ['list member', carol, '/np/issues'],
      [
        'list project+status',
        alice,
        `/np/issues?projectId=${projectId}&statusKey=todo`,
      ],
      ['list search', alice, '/np/issues?q=Issue%2012'],
      ['list created', alice, '/np/issues?sort=created&limit=100'],
      ['board', alice, '/np/issues?view=board'],
      ['board project', carol, `/np/issues?view=board&projectId=${projectId}`],
      [
        'board column',
        alice,
        '/np/issues?view=board&statusKey=todo&columnLimit=100',
      ],
      [
        'detail (3000 activities, 300 comments)',
        alice,
        `/np/issues/${hotIssueId}`,
      ],
      [
        'activities page',
        alice,
        `/np/issues/${hotIssueId}/activities?limit=200`,
      ],
    ];
    for (const [name, api, path] of cases) await measure(name, api, path);
    console.info(
      `[np-perf] median ms (target ${TARGET_MS}, budget ${BUDGET_MS}): ${JSON.stringify(timings)}`,
    );
    for (const [name, value] of Object.entries(timings))
      expect(value, `${name} took ${value} ms`).toBeLessThan(BUDGET_MS);

    const detail = await alice<{ data: IssueDetailV3 }>(
      'GET',
      `/np/issues/${hotIssueId}`,
    );
    expect(detail.body.data.activities).toHaveLength(50);
    expect(detail.body.data.comments).toHaveLength(200);
    expect(detail.body.data.issue.subtaskCount).toBe(20);
    const board = await alice<{
      data: { groups: BoardGroupV3<{ id: string }>[] };
    }>('GET', '/np/issues?view=board');
    expect(
      board.body.data.groups.every((group) => group.issues.length <= 50),
    ).toBe(true);
  });

  it('visits every visible issue exactly once in a full cursor walk', async () => {
    for (const [api, expected, name] of [
      [alice, 2200, 'walk owner'],
      [carol, 2000, 'walk member'],
    ] as const) {
      const started = performance.now();
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const response: { body: IssueListPage<{ id: string }> } = await api<
          IssueListPage<{ id: string }>
        >(
          'GET',
          `/np/issues?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        for (const row of response.body.data) {
          expect(seen.has(row.id)).toBe(false);
          seen.add(row.id);
        }
        cursor = response.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 100);
      expect(seen.size).toBe(expected);
      timings[name] = Math.round(performance.now() - started);
    }
    console.info(`[np-perf] full walks ms: ${JSON.stringify(timings)}`);
  });
});
