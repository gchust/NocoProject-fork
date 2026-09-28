// @vitest-environment node
/**
 * Iteration 1 trigger gating on a real PostgreSQL (contract §D): blocked issues do not enqueue, terminal blockers
 * release dependents (`dependencyReleased`) and later stages, a finished batch wakes the parent executor
 * (`childBatchDone`, coalesced, not when the parent is dormant), `start: false`, dependency cycles.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type { IssueV1 } from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  runRows,
  triggerRows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_subtasks');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-subtasks] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let alpha: string;
let beta: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  const { runtimeId } = await registerRuntime(services, ALICE);
  alpha = await createAgent(services, ALICE, runtimeId, 'Alpha');
  beta = await createAgent(services, ALICE, runtimeId, 'Beta');
});

async function setStatus(issue: IssueV1, statusKey: string): Promise<IssueV1> {
  const current = await services.issueQueries.detail(ALICE, issue.id);
  return services.issues.update(ALICE, issue.id, {
    statusKey,
    revision: current.issue.revision,
  });
}

/** JSON columns read back through raw SQL: an object, or serialized text. */
function decode(value: unknown): unknown {
  let current = value;
  while (typeof current === 'string') current = JSON.parse(current) as unknown;
  return current;
}

async function triggerTypes(issueId: string): Promise<string[]> {
  const runs = await runRows(db!, `subject_id = '${issueId}'`);
  const types: string[] = [];
  for (const run of runs)
    for (const trigger of await triggerRows(db!, run.id as string))
      types.push(trigger.type as string);
  return types;
}

describe.skipIf(!db)('blocking and release (PostgreSQL)', () => {
  it('does not enqueue a blocked issue, records why, and releases it when the blocker is done', async () => {
    const blocker = await services.issues.create(ALICE, { title: 'Blocker' });
    const blocked = await services.issues.create(ALICE, {
      title: 'Blocked',
      blockedBy: [blocker.identifier],
      executor: { type: 'agent', id: alpha },
    });
    expect(await runRows(db!, `subject_id = '${blocked.id}'`)).toHaveLength(0);
    const activity = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'run_deferred_blocked'",
      [blocked.id],
    );
    expect(activity).toHaveLength(1);
    const detail = await services.issueQueries.detail(ALICE, blocked.id);
    expect(detail.blockers).toEqual([
      expect.objectContaining({ issueId: blocker.id, reason: 'dependency' }),
    ]);
    expect(detail.issue.blockedCount).toBe(1);
    expect(detail.blockedBy).toEqual([
      expect.objectContaining({ issueId: blocker.id, type: 'blockedBy' }),
    ]);

    // A comment while blocked does not enqueue either.
    await services.comments.create(ALICE, blocked.id, { content: 'ping' });
    expect(await runRows(db!, `subject_id = '${blocked.id}'`)).toHaveLength(0);

    await setStatus(blocker, 'done');
    const [run] = await runRows(db!, `subject_id = '${blocked.id}'`);
    expect(run).toMatchObject({ agent_id: alpha, actor_user_id: ALICE.id });
    expect(await triggerTypes(blocked.id)).toEqual(['dependencyReleased']);
  });

  it('tells the owner when a released issue has no executor', async () => {
    const blocker = await services.issues.create(ALICE, { title: 'Blocker' });
    const waiting = await services.issues.create(ALICE, {
      title: 'Waiting',
      blockedBy: [blocker.id],
    });
    // Close as Bob-less Alice: Alice is the actor and the owner, but the release is a system notice.
    await setStatus(blocker, 'cancelled');
    const items = await rows(
      db!,
      'inbox_items',
      "type = 'dependency_released'",
    );
    expect(items).toEqual([
      expect.objectContaining({ user_id: ALICE.id, issue_id: waiting.id }),
    ]);
  });

  it('starts a later stage only when every earlier sibling is terminal', async () => {
    const parent = await services.issues.create(ALICE, { title: 'Parent' });
    const s1a = await services.issues.create(ALICE, {
      title: 'Stage 1 a',
      parentIssueId: parent.id,
      stage: 1,
    });
    const s1b = await services.issues.create(ALICE, {
      title: 'Stage 1 b',
      parentIssueId: parent.id,
      stage: 1,
    });
    const s2 = await services.issues.create(ALICE, {
      title: 'Stage 2',
      parentIssueId: parent.id,
      stage: 2,
      executor: { type: 'agent', id: beta },
    });
    expect(await runRows(db!, `subject_id = '${s2.id}'`)).toHaveLength(0);
    expect(
      (await services.issueQueries.detail(ALICE, s2.id)).blockers.map(
        (item) => item.reason,
      ),
    ).toEqual(['stage', 'stage']);

    await setStatus(s1a, 'done');
    expect(await runRows(db!, `subject_id = '${s2.id}'`)).toHaveLength(0);
    await setStatus(s1b, 'done');
    expect(await triggerTypes(s2.id)).toEqual(['dependencyReleased']);
  });

  it('wakes the parent executor when a batch finishes, coalescing into its pending run', async () => {
    const parent = await services.issues.create(ALICE, {
      title: 'Parent',
      executor: { type: 'agent', id: alpha },
    });
    const [assignRun] = await runRows(db!, `subject_id = '${parent.id}'`);
    const a = await services.issues.create(ALICE, {
      title: 'A',
      parentIssueId: parent.id,
      stage: 1,
    });
    const b = await services.issues.create(ALICE, {
      title: 'B',
      parentIssueId: parent.id,
      stage: 1,
    });
    await services.issues.create(ALICE, {
      title: 'C',
      parentIssueId: parent.id,
      stage: 2,
    });
    await setStatus(a, 'done');
    expect(await triggerTypes(parent.id)).toEqual(['assign']);
    await setStatus(b, 'done');
    // The assign run is still queued: the wake coalesces into it.
    const runs = await runRows(db!, `subject_id = '${parent.id}'`);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(assignRun!.id);
    expect(await triggerTypes(parent.id)).toEqual(['assign', 'childBatchDone']);
    const [wake] = (await triggerRows(db!, assignRun!.id as string)).filter(
      (row) => row.type === 'childBatchDone',
    );
    expect(decode(wake!.payload)).toEqual({
      stage: 1,
      childIssueIds: [a.id, b.id],
    });
    expect(
      await rows(db!, 'inbox_items', "type = 'batch_done' AND issue_id = ?", [
        parent.id,
      ]),
    ).toHaveLength(1);
  });

  it('does not wake a dormant parent', async () => {
    const parent = await services.issues.create(ALICE, {
      title: 'Parent',
      statusKey: 'backlog',
      executor: { type: 'agent', id: alpha },
    });
    const child = await services.issues.create(ALICE, {
      title: 'Only child',
      parentIssueId: parent.id,
    });
    await setStatus(child, 'done');
    expect(await runRows(db!, `subject_id = '${parent.id}'`)).toHaveLength(0);
    // The owner still hears about it.
    expect(
      await rows(db!, 'inbox_items', "type = 'batch_done' AND issue_id = ?", [
        parent.id,
      ]),
    ).toHaveLength(1);
  });

  it('does not start when asked not to (start: false)', async () => {
    const quiet = await services.issues.create(ALICE, {
      title: 'Quiet',
      executor: { type: 'agent', id: alpha },
      start: false,
    });
    expect(await runRows(db!, `subject_id = '${quiet.id}'`)).toHaveLength(0);
    const backlog = await services.issues.create(ALICE, {
      title: 'Later',
      statusKey: 'backlog',
      executor: { type: 'agent', id: alpha },
    });
    await services.issues.update(ALICE, backlog.id, {
      statusKey: 'todo',
      autoExecuteSubtasks: true,
      start: false,
      revision: backlog.revision,
    });
    expect(await runRows(db!, `subject_id = '${backlog.id}'`)).toHaveLength(0);
    const updated = await services.issueQueries.detail(ALICE, backlog.id);
    expect(updated.issue).toMatchObject({
      statusKey: 'todo',
      autoExecuteSubtasks: true,
    });
  });

  it('releases when the last blocking dependency is removed', async () => {
    const blocker = await services.issues.create(ALICE, { title: 'Blocker' });
    const blocked = await services.issues.create(ALICE, {
      title: 'Blocked',
      blockedBy: [blocker.id],
      executor: { type: 'agent', id: alpha },
    });
    const [dependency] = (await services.issueQueries.detail(ALICE, blocked.id))
      .blockedBy;
    await services.dependencies.remove(
      ALICE,
      blocked.identifier,
      dependency!.dependencyId,
    );
    expect(await triggerTypes(blocked.id)).toEqual(['dependencyReleased']);
  });

  it('rejects self, mutual and transitive dependency cycles', async () => {
    const a = await services.issues.create(ALICE, { title: 'A' });
    const b = await services.issues.create(ALICE, { title: 'B' });
    const c = await services.issues.create(ALICE, { title: 'C' });
    await expect(
      services.dependencies.add(ALICE, a.id, { dependsOnIssueId: a.id }),
    ).rejects.toMatchObject({ code: 'INVALID_DEPENDENCY' });
    await services.dependencies.add(ALICE, a.id, { dependsOnIssueId: b.id });
    await expect(
      services.dependencies.add(ALICE, b.id, { dependsOnIssueId: a.id }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
    await services.dependencies.add(ALICE, b.id, { dependsOnIssueId: c.id });
    await expect(
      services.dependencies.add(ALICE, c.id, {
        dependsOnIssueId: a.identifier,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
    await expect(
      services.dependencies.add(ALICE, a.id, { dependsOnIssueId: b.id }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_EXISTS' });
    // relatedTo is not gated and not cycle-checked beyond direct mutual references.
    const related = await services.dependencies.add(ALICE, c.id, {
      dependsOnIssueId: a.id,
      type: 'relatedTo',
    });
    expect(related.type).toBe('relatedTo');
    expect((await services.issueQueries.detail(ALICE, a.id)).blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issueId: c.id, type: 'relatedTo' }),
      ]),
    );
  });

  it('lists subtasks with stage, executor and blocked counts, and filters and groups the board', async () => {
    const parent = await services.issues.create(ALICE, { title: 'Parent' });
    await services.issues.create(ALICE, {
      title: 'One',
      parentIssueId: parent.id,
      stage: 1,
    });
    await services.issues.create(ALICE, {
      title: 'Two',
      parentIssueId: parent.id,
      stage: 2,
      executor: { type: 'agent', id: beta },
      start: false,
    });
    const detail = await services.issueQueries.detail(ALICE, parent.id);
    expect(
      detail.subtasks.map((item) => [
        item.title,
        item.stage,
        item.blockedCount,
      ]),
    ).toEqual([
      ['One', 1, 0],
      ['Two', 2, 1],
    ]);
    expect(detail.subtasks[1]).toMatchObject({ executorName: 'Beta' });
    expect(detail.issue.subtaskCount).toBe(2);
    const children = await services.issueQueries.list(ALICE, {
      parentIssueId: parent.id,
    });
    expect(children).toHaveLength(2);
    const topLevel = await services.issueQueries.list(ALICE, {
      parentIssueId: 'none',
    });
    expect(topLevel.map((issue) => issue.id)).toEqual([parent.id]);
    const board = await services.issueQueries.board(ALICE, {});
    expect(board.groups.map((group) => group.statusKey)).toEqual([
      'backlog',
      'todo',
      // Iteration 4: the design-first statuses of the default template.
      'analysis',
      'proposal_review',
      'in_progress',
      'in_review',
      'blocked',
      'done',
      'cancelled',
    ]);
    expect(board.groups[1]!.issues).toHaveLength(3);
  });
});
