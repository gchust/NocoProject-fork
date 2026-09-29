// @vitest-environment node
/**
 * Trigger rules (protocol.md §2), agent status enforcement (§1.1), optimistic revisions and failure handling, on a
 * real PostgreSQL.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import {
  ALICE,
  buildServices,
  createAgent,
  mention,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  runRows,
  triggerRows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_triggers');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-triggers] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let runtimeId: string;
let daemonId: string;
let alpha: string;
let beta: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  ({ runtimeId, daemonId } = await registerRuntime(services, ALICE));
  alpha = await createAgent(services, ALICE, runtimeId, 'Alpha');
  beta = await createAgent(services, ALICE, runtimeId, 'Beta');
});

const agentActor = (agentId: string, runId: string): Actor => ({
  type: 'agent',
  id: agentId,
  runId,
});

async function claimAndStart(): Promise<string> {
  const response = await services.claims.claim(
    ALICE.id!,
    { daemonId, configurationProtocol: 1, slots: [{ runtimeId, free: 1 }] },
    'u',
  );
  const runId = response.runs[0]!.run.id;
  await services.runs.start(runId, { workDir: '/w' });
  return runId;
}

describe.skipIf(!db)('issue trigger rules (PostgreSQL)', () => {
  it('assigning an agent enqueues; backlog does not; leaving backlog does', async () => {
    const assigned = await services.issues.create(ALICE, {
      title: 'A',
      executor: { type: 'agent', id: alpha },
    });
    const [run] = await runRows(db!, `subject_id = '${assigned.id}'`);
    expect(run).toMatchObject({
      agent_id: alpha,
      status: 'queued',
      thread_scope: null,
      actor_user_id: ALICE.id,
    });
    expect(
      (await triggerRows(db!, run!.id as string)).map((row) => row.type),
    ).toEqual(['assign']);

    const backlog = await services.issues.create(ALICE, {
      title: 'B',
      statusKey: 'backlog',
      executor: { type: 'agent', id: alpha },
    });
    expect(await runRows(db!, `subject_id = '${backlog.id}'`)).toHaveLength(0);

    const moved = await services.issues.update(ALICE, backlog.id, {
      statusKey: 'todo',
      revision: backlog.revision,
    });
    const [statusRun] = await runRows(db!, `subject_id = '${backlog.id}'`);
    expect(
      (await triggerRows(db!, statusRun!.id as string)).map((row) => row.type),
    ).toEqual(['statusChange']);
    expect(moved.revision).toBe(backlog.revision + 1);

    // Re-assigning to a different agent enqueues for that agent.
    await services.issues.update(ALICE, backlog.id, {
      executor: { type: 'agent', id: beta },
      revision: moved.revision,
    });
    expect(
      await runRows(
        db!,
        `subject_id = '${backlog.id}' AND agent_id = '${beta}'`,
      ),
    ).toHaveLength(1);
  });

  it('a mention enqueues once per mentioned agent, scoped to the thread root', async () => {
    const issue = await services.issues.create(ALICE, { title: 'Mentions' });
    const root = await services.comments.create(ALICE, issue.id, {
      content: `${mention(alpha, 'Alpha')} and ${mention(beta, 'Beta')} and ${mention(alpha, 'Alpha')} again`,
    });
    expect(root.triggered.map((item) => item.agentId).sort()).toEqual(
      [alpha, beta].sort(),
    );
    const runs = await runRows(db!, `subject_id = '${issue.id}'`);
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.thread_scope).toBe(root.comment.id);

    // A reply in the same thread mentioning Alpha coalesces into Alpha's pending run.
    const reply = await services.comments.create(ALICE, issue.id, {
      content: `${mention(alpha)} more`,
      parentId: root.comment.id,
    });
    expect(reply.comment.rootId).toBe(root.comment.id);
    const alphaRun = runs.find((run) => run.agent_id === alpha)!;
    expect(reply.triggered).toEqual([{ agentId: alpha, runId: alphaRun.id }]);
    expect(
      (await triggerRows(db!, alphaRun.id as string)).map((row) => row.type),
    ).toEqual(['mention', 'mention']);
    expect(await runRows(db!, `subject_id = '${issue.id}'`)).toHaveLength(2);
  });
});

describe.skipIf(!db)('comment trigger rules (PostgreSQL)', () => {
  it('agent-authored comments and /note comments never trigger', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Quiet',
      executor: { type: 'agent', id: alpha },
    });
    const runId = await claimAndStart();
    const byAgent = await services.comments.create(
      agentActor(alpha, runId),
      issue.id,
      {
        content: `${mention(beta)} please help`,
      },
    );
    expect(byAgent.triggered).toEqual([]);
    expect(byAgent.comment).toMatchObject({
      authorType: 'agent',
      authorName: 'Alpha',
      sourceRunId: runId,
    });

    const note = await services.comments.create(ALICE, issue.id, {
      content: `/note ${mention(beta)} fyi`,
    });
    expect(note.triggered).toEqual([]);
    expect(await runRows(db!, `agent_id = '${beta}'`)).toHaveLength(0);
  });

  it('a reply to an agent comment routes to that agent; a top-level comment routes to the executor', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Replies',
      executor: { type: 'agent', id: alpha },
    });
    const assignRunId = (await runRows(db!, `subject_id = '${issue.id}'`))[0]!
      .id as string;

    // Top-level comment coalesces into the pending assign run (same agent, subject, null scope).
    const topLevel = await services.comments.create(ALICE, issue.id, {
      content: 'Also check the tests',
    });
    expect(topLevel.triggered).toEqual([
      { agentId: alpha, runId: assignRunId },
    ]);
    expect(
      (await triggerRows(db!, assignRunId)).map((row) => row.type),
    ).toEqual(['assign', 'comment']);

    await claimAndStart();
    const current = await services.issueQueries.detail(ALICE, issue.id);
    await services.issues.update(ALICE, issue.id, {
      executor: { type: 'agent', id: beta },
      revision: current.issue.revision,
    });
    const runId = await claimAndStart();
    const agentComment = await services.comments.create(
      agentActor(beta, runId),
      issue.id,
      { content: 'Beta here' },
    );
    const reply = await services.comments.create(ALICE, issue.id, {
      content: 'Thanks, one question',
      parentId: agentComment.comment.id,
    });
    expect(reply.triggered).toHaveLength(1);
    expect(reply.triggered[0]!.agentId).toBe(beta);
    const [replyRun] = await runRows(
      db!,
      `id = '${reply.triggered[0]!.runId}'`,
    );
    expect(replyRun!.thread_scope).toBe(agentComment.comment.id);
    expect(
      (await triggerRows(db!, replyRun!.id as string)).map((row) => row.type),
    ).toEqual(['reply']);
  });
});

describe.skipIf(!db)('issue writes (PostgreSQL)', () => {
  it('numbers issues atomically under concurrency', async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        services.issues.create(ALICE, { title: `Concurrent ${index}` }),
      ),
    );
    expect(created.map((issue) => issue.number).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(
      created.every((issue) => issue.identifier === `NP-${issue.number}`),
    ).toBe(true);
  });

  it('rejects a stale revision with REVISION_CONFLICT', async () => {
    const issue = await services.issues.create(ALICE, { title: 'Rev' });
    await services.issues.update(ALICE, issue.id, {
      title: 'Rev 2',
      revision: issue.revision,
    });
    await expect(
      services.issues.update(ALICE, issue.id, {
        title: 'Rev 3',
        revision: issue.revision,
      }),
    ).rejects.toMatchObject({
      kind: 'conflict',
      code: 'REVISION_CONFLICT',
    });
  });

  it('records activities with from/to details', async () => {
    const issue = await services.issues.create(ALICE, { title: 'Act' });
    await services.issues.update(ALICE, issue.id, {
      statusKey: 'in_review',
      priority: 'high',
      revision: issue.revision,
    });
    const detail = await services.issueQueries.detail(ALICE, issue.identifier);
    const actions = detail.activities.map((activity) => activity.action);
    expect(actions).toEqual([
      'issue_created',
      'process_selected',
      'status_changed',
      'priority_changed',
    ]);
    expect(detail.activities[2]).toMatchObject({
      actorName: 'Alice',
      details: { from: 'todo', to: 'in_review' },
    });
  });
});

describe.skipIf(!db)('agent status transitions (PostgreSQL)', () => {
  it('allows only the agent transitions and lets humans write any', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Status',
      executor: { type: 'agent', id: alpha },
    });
    const runId = await claimAndStart();
    const agent = agentActor(alpha, runId);

    await expect(
      services.issues.agentSetStatus(agent, issue.id, 'done'),
    ).rejects.toMatchObject({
      kind: 'forbidden',
      code: 'TRANSITION_NOT_ALLOWED',
    });
    expect(
      (await services.issues.agentSetStatus(agent, issue.id, 'in_progress'))
        .statusKey,
    ).toBe('in_progress');
    expect(
      (await services.issues.agentSetStatus(agent, issue.id, 'blocked'))
        .statusKey,
    ).toBe('blocked');
    expect(
      (await services.issues.agentSetStatus(agent, issue.id, 'in_progress'))
        .statusKey,
    ).toBe('in_progress');
    expect(
      (await services.issues.agentSetStatus(agent, issue.id, 'in_review'))
        .statusKey,
    ).toBe('in_review');
    await expect(
      services.issues.agentSetStatus(agent, issue.id, 'todo'),
    ).rejects.toMatchObject({
      code: 'TRANSITION_NOT_ALLOWED',
    });

    const current = await services.issueQueries.detail(ALICE, issue.id);
    const human = await services.issues.update(ALICE, issue.id, {
      statusKey: 'done',
      revision: current.issue.revision,
    });
    expect(human.statusKey).toBe('done');
    // Agent status changes never trigger runs.
    expect(
      await runRows(db!, `subject_id = '${issue.id}' AND status = 'queued'`),
    ).toHaveLength(0);
  });
});

describe.skipIf(!db)('failures and retries (PostgreSQL)', () => {
  it('retries a retryable failure and carries the original triggers', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Flaky',
      executor: { type: 'agent', id: alpha },
    });
    const runId = await claimAndStart();
    await services.runRecovery.fail(runId, {
      reason: 'agentError.providerNetwork',
      detail: 'ECONNRESET',
    });
    const [retry] = await runRows(db!, `retry_of_run_id = '${runId}'`);
    expect(retry).toMatchObject({
      status: 'queued',
      attempt: 2,
      max_attempts: 3,
      subject_id: issue.id,
    });
    expect(
      (await triggerRows(db!, retry!.id as string)).map((row) => row.type),
    ).toEqual(['assign', 'retry']);

    // Attempts are bounded: attempt 3 of 3 failing does not create a fourth.
    const second = await claimAndStart();
    await services.runRecovery.fail(second, {
      reason: 'agentError.providerNetwork',
    });
    const third = await claimAndStart();
    await services.runRecovery.fail(third, {
      reason: 'agentError.providerNetwork',
    });
    expect(await runRows(db!, `retry_of_run_id = '${third}'`)).toHaveLength(0);
  });

  it('does not retry other reasons and puts an abandoned in-progress issue back to todo', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Broken',
      executor: { type: 'agent', id: alpha },
    });
    const runId = await claimAndStart();
    await services.issues.agentSetStatus(
      agentActor(alpha, runId),
      issue.id,
      'in_progress',
    );
    await services.runRecovery.fail(runId, {
      reason: 'agentError.providerAuth',
      sessionPoisoned: true,
    });
    expect(await runRows(db!, `retry_of_run_id = '${runId}'`)).toHaveLength(0);
    const detail = await services.issueQueries.detail(ALICE, issue.id);
    expect(detail.issue.statusKey).toBe('todo');
    expect(detail.activities.at(-1)).toMatchObject({
      actorType: 'system',
      details: { from: 'in_progress', to: 'todo' },
    });
    const sessions = (await db!.knex.raw(
      'SELECT poisoned FROM run_sessions',
    )) as { rows: { poisoned: boolean }[] };
    expect(sessions.rows).toEqual([{ poisoned: true }]);
  });

  it('a poisoned session makes the next claim start fresh', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Overflow',
      executor: { type: 'agent', id: alpha },
    });
    const first = await claimAndStart();
    await services.runs.complete(first, {
      workDir: '/w',
      providerSessionId: 'sess-1',
    });
    await services.comments.create(ALICE, issue.id, { content: 'again' });
    const second = await claimAndStart();
    await services.runRecovery.fail(second, {
      reason: 'agentError.contextOverflow',
      providerSessionId: 'sess-1',
    });
    await services.runRecovery.retry(ALICE, second);
    const claimed = await services.claims.claim(
      ALICE.id!,
      { daemonId, configurationProtocol: 1, slots: [{ runtimeId, free: 1 }] },
      'u',
    );
    expect(claimed.runs[0]!.session.fresh).toBe(true);
    expect(claimed.runs[0]!.session.providerSessionId).toBeNull();
  });

  it('cancels queued runs directly and executing runs after the daemon acknowledges', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Stop',
      executor: { type: 'agent', id: alpha },
    });
    const [queued] = await runRows(db!, `subject_id = '${issue.id}'`);
    expect(
      (await services.runs.requestCancel(ALICE, queued!.id as string)).status,
    ).toBe('cancelled');

    await services.comments.create(ALICE, issue.id, { content: 'try again' });
    const runId = await claimAndStart();
    const requested = await services.runs.requestCancel(ALICE, runId);
    expect(requested.status).toBe('running');
    expect(await services.runs.daemonStatus(runId)).toEqual({
      status: 'running',
      cancelRequested: true,
    });
    expect((await services.runs.cancelAck(runId)).status).toBe('cancelled');
  });
});

describe.skipIf(!db)(
  'queued runs and new blockers (iteration 2 §K, PostgreSQL)',
  () => {
    it('withdraws queued runs when a blocking dependency is added, and leaves dispatched runs alone', async () => {
      const blocker = await services.issues.create(ALICE, { title: 'Blocker' });
      const queued = await services.issues.create(ALICE, {
        title: 'Queued',
        executor: { type: 'agent', id: alpha },
      });
      const [run] = await runRows(db!, `subject_id = '${queued.id}'`);
      expect(run?.status).toBe('queued');
      await services.dependencies.add(ALICE, queued.id, {
        dependsOnIssueId: blocker.id,
      });
      const [withdrawn] = await runRows(db!, `subject_id = '${queued.id}'`);
      expect(withdrawn).toMatchObject({
        status: 'cancelled',
        failure_reason: 'blocked',
      });
      const detail = await services.issueQueries.detail(ALICE, queued.id);
      const deferred = detail.activities.find(
        (item) => item.action === 'run_deferred_blocked',
      );
      expect(deferred?.details).toMatchObject({
        runId: run?.id,
        withdrawn: true,
        triggerType: 'assign',
        blockers: [expect.objectContaining({ issueId: blocker.id })],
      });

      const busy = await services.issues.create(ALICE, {
        title: 'Busy',
        executor: { type: 'agent', id: beta },
      });
      await claimAndStart();
      await services.dependencies.add(ALICE, busy.id, {
        dependsOnIssueId: blocker.id,
      });
      const [running] = await runRows(db!, `subject_id = '${busy.id}'`);
      expect(running?.status).toBe('running');
    });

    it('keeps queued runs when the new dependency is already finished or only related', async () => {
      const finished = await services.issues.create(ALICE, { title: 'Done' });
      await services.issues.update(ALICE, finished.id, {
        statusKey: 'done',
        revision: finished.revision,
      });
      const queued = await services.issues.create(ALICE, {
        title: 'Queued',
        executor: { type: 'agent', id: alpha },
      });
      await services.dependencies.add(ALICE, queued.id, {
        dependsOnIssueId: finished.id,
      });
      const other = await services.issues.create(ALICE, { title: 'Other' });
      await services.dependencies.add(ALICE, queued.id, {
        dependsOnIssueId: other.id,
        type: 'relatedTo',
      });
      const [run] = await runRows(db!, `subject_id = '${queued.id}'`);
      expect(run?.status).toBe('queued');
    });
  },
);
