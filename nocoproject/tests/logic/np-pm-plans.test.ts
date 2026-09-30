// @vitest-environment node
/**
 * Operation plan cards on a real PostgreSQL (NP-183, protocol-pm-assistant.md §4, §13): checked before they are
 * stored, edited without new rows, executed atomically as the owner (`via: 'pm_plan'`), `STALE_TARGET`, one of two
 * concurrent executions, expiry, supersede, discard, the `plan_result` comment and the `planExecuted` wake-up.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type {
  PmConversationDetail,
  PmPlan,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  claimOne,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  runRows,
  setRole,
  type Fixture,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  agentApi4,
  browserApi4,
  createKindAgent,
  type ApiCall,
} from './np-iter4-harness.ts';

const opened = await openNpTestDatabase('np_t_pm_plans');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-pm-plans] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

type Data<T> = { data: T };

let services: NpServices;
let alice: ApiCall;
let bob: ApiCall;
let pmRuntime: Fixture;
let manager: string;
let conversationId: string;
let pm: ApiCall;
let runId: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'member');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'owner');
  alice = browserApi4(services, ALICE);
  bob = browserApi4(services, BOB);
  pmRuntime = await registerRuntime(services, CAROL, 'daemon-pm');
  manager = await createKindAgent(services, CAROL, pmRuntime.runtimeId, 'PM', 'manager');
  await services.workspaceSettings.update(CAROL, { pmAgentId: manager });
  const created = await alice<Data<PmConversationDetail>>('POST', '/np/pm/conversations', {});
  conversationId = created.body.data.id;
  await alice('POST', `/np/issues/${conversationId}/comments`, { content: 'Plan the release' });
  const claimed = await claimOne(services, CAROL, pmRuntime);
  if (!claimed) throw new Error('No conversation run');
  pm = agentApi4(services, claimed.token);
  runId = claimed.run.id;
});

const TWO_ISSUES = {
  title: 'Release tasks',
  summary: 'Two tasks, the second after the first.',
  ops: [
    { type: 'issue.create', ref: 't1', params: { title: 'Write notes', process: 'direct' } },
    {
      type: 'issue.create',
      ref: 't2',
      params: { title: 'Publish', process: 'direct', blockedBy: [{ ref: 't1' }] },
    },
  ],
};

async function proposed(body: unknown = TWO_ISSUES): Promise<PmPlan> {
  const answer = await pm<Data<PmPlan>>('POST', '/pm/plans', body);
  expect(answer.status).toBe(201);
  return answer.body.data;
}

describe.skipIf(!db)('operation plan cards (PostgreSQL)', () => {
  it('refuses a plan with a row the member may not perform, writing nothing', async () => {
    const secret = await services.projects.create(CAROL, { name: 'Secret', visibility: 'members' });
    const hidden = await services.issues.create(CAROL, { title: 'Hidden', projectId: secret.id });
    const answer = await pm('POST', '/pm/plans', {
      title: 'x',
      ops: [
        { type: 'issue.create', ref: 'a', params: { title: 'Fine' } },
        { type: 'issue.update', params: { issue: hidden.id, set: { title: 'No' } } },
      ],
    });
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe('PLAN_INVALID');
    const details = (answer.body as { details?: { rows: { seq: number; ok: boolean }[] } }).details;
    expect(details?.rows.map((row) => row.ok)).toEqual([true, false]);
    expect(await rows(db!, 'pm_plans', '1 = 1', [])).toEqual([]);
    expect(await rows(db!, 'issues', "title = 'Fine'", [])).toEqual([]);
    const tooMany = await pm('POST', '/pm/plans', { title: 'x', ops: [] });
    expect(tooMany.body.code).toBe('PLAN_TOO_LARGE');
    const kb = await pm('POST', '/pm/plans', {
      title: 'x',
      ops: [{ type: 'knowledge.propose', params: {} }],
    });
    expect(kb.body.code).toBe('UNSUPPORTED_OPERATION');
  });

  it('executes every row as the owner, reports back and wakes the agent', async () => {
    const plan = await proposed();
    expect(plan).toMatchObject({ status: 'pending', executable: true, revision: 1 });
    const [card] = await rows(db!, 'comments', "issue_id = ? AND kind = 'plan'", [conversationId]);
    expect(card).toMatchObject({ author_type: 'agent', author_id: manager });
    // Nobody but the owner sees the plan.
    expect((await bob('GET', `/np/pm/plans/${plan.id}`)).status).toBe(404);
    // The run finishes, so the plan's wake-up becomes a new run.
    await services.runs.complete(runId, { providerSessionId: 's', workDir: '/tmp/pm' });

    const executed = await alice<Data<PmPlan>>('POST', `/np/pm/plans/${plan.id}/execute`, {
      revision: 1,
    });
    expect(executed.body.data.status).toBe('executed');
    const [first, second] = executed.body.data.rows;
    expect(first).toMatchObject({ status: 'done', resultType: 'issue' });
    const created = await rows(db!, 'issues', "title IN ('Write notes', 'Publish')", []);
    expect(created).toHaveLength(2);
    expect(created.every((row) => row.owner_user_id === ALICE.id)).toBe(true);
    const deps = await rows(db!, 'issue_dependencies', 'issue_id = ?', [second!.resultId]);
    expect(deps[0]?.depends_on_issue_id).toBe(first!.resultId);
    const [activity] = await rows(db!, 'activities', "issue_id = ? AND action = 'issue_created'", [first!.resultId]);
    const details = typeof activity?.details === 'string' ? JSON.parse(activity.details) : activity?.details;
    expect(details).toMatchObject({ via: 'pm_plan', planId: plan.id, conversationId });

    const [result] = await rows(db!, 'comments', "issue_id = ? AND kind = 'plan_result'", [conversationId]);
    expect(String(result?.content)).toContain('Plan executed.');
    const [wake] = await runRows(db!, "status = 'queued'");
    expect(wake).toMatchObject({ agent_id: manager, subject_id: conversationId, actor_user_id: ALICE.id });
    const claimed = (await claimOne(services, CAROL, pmRuntime)) as unknown as {
      triggers: { type: string; plan?: { planId: string; status: string }; comment?: { id: string } }[];
    };
    expect(claimed.triggers[0]).toMatchObject({
      type: 'planExecuted',
      plan: { planId: plan.id, status: 'executed' },
      comment: { id: String(result?.id) },
    });
    const again = await alice('POST', `/np/pm/plans/${plan.id}/execute`, { revision: 1 });
    expect(again.body.code).toBe('PLAN_NOT_PENDING');
  });

  it('rolls everything back when a row fails, and runs again after an edit', async () => {
    const target = await services.issues.create(ALICE, { title: 'Old title' });
    const plan = await proposed({
      title: 'Mixed',
      ops: [
        { type: 'issue.create', ref: 'n', params: { title: 'New one', process: 'direct' } },
        { type: 'issue.update', params: { issue: target.id, set: { title: 'Planned title' } } },
      ],
    });
    // Somebody changes the issue after the plan was made.
    await services.issues.update(ALICE, target.id, { title: 'Changed meanwhile', revision: target.revision });
    const failed = await alice<Data<PmPlan>>('POST', `/np/pm/plans/${plan.id}/execute`, { revision: 1 });
    expect(failed.body.data.status).toBe('failed');
    expect(failed.body.data.rows[1]).toMatchObject({ status: 'failed', errorCode: 'STALE_TARGET' });
    expect(await rows(db!, 'issues', "title = 'New one'", [])).toEqual([]);
    const [result] = await rows(db!, 'comments', "issue_id = ? AND kind = 'plan_result'", [conversationId]);
    expect(String(result?.content)).toContain('nothing was changed');

    // Edits: never a new row, never a stale revision, never removing a row others use.
    expect((await alice('PATCH', `/np/pm/plans/${plan.id}`, { revision: 9, ops: [] })).body.code).toBe('REVISION_CONFLICT');
    expect((await alice('PATCH', `/np/pm/plans/${plan.id}`, { revision: 1, ops: [{ seq: 3, removed: true }] })).body.code).toBe('INVALID_PLAN');
    const edited = await alice<Data<PmPlan>>('PATCH', `/np/pm/plans/${plan.id}`, {
      revision: 1,
      ops: [{ seq: 2, params: { issue: target.id, set: { title: 'Planned title' } } }],
    });
    expect(edited.body.data).toMatchObject({ status: 'pending', revision: 2, executable: true });
    const done = await alice<Data<PmPlan>>('POST', `/np/pm/plans/${plan.id}/execute`, { revision: 2 });
    expect(done.body.data.status).toBe('executed');
    const [row] = await rows(db!, 'issues', 'id = ?', [target.id]);
    expect(row?.title).toBe('Planned title');
  });

  it('lets one of two concurrent executions through', async () => {
    const plan = await proposed();
    const [a, b] = await Promise.all([
      alice('POST', `/np/pm/plans/${plan.id}/execute`, { revision: 1 }),
      alice('POST', `/np/pm/plans/${plan.id}/execute`, { revision: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await rows(db!, 'issues', "title = 'Write notes'", [])).toHaveLength(1);
  });

  it('expires, is superseded and discarded without waking anyone', async () => {
    const first = await proposed();
    const second = await proposed();
    expect((await alice<Data<PmPlan>>('GET', `/np/pm/plans/${first.id}`)).body.data.status).toBe('superseded');
    await db!.knex.withSchema(db!.schema).table('pm_plans').where({ id: second.id }).update({ expires_at: new Date(Date.now() - 1000) });
    const expired = await alice('POST', `/np/pm/plans/${second.id}/execute`, { revision: 1 });
    expect(expired.body.code).toBe('PLAN_EXPIRED');
    expect((await alice<Data<PmPlan>>('GET', `/np/pm/plans/${second.id}`)).body.data.status).toBe('expired');
    const third = await proposed();
    const before = (await runRows(db!)).length;
    const discarded = await pm<Data<PmPlan>>('POST', `/pm/plans/${third.id}/discard`);
    expect(discarded.body.data.status).toBe('discarded');
    expect((await alice('POST', `/np/pm/plans/${third.id}/discard`)).body.code).toBe('PLAN_NOT_PENDING');
    expect(await runRows(db!)).toHaveLength(before);
    const listed = await alice<Data<PmPlan[]>>('GET', `/np/pm/conversations/${conversationId}/plans`);
    expect(listed.body.data.map((plan) => plan.id)).toEqual([third.id, second.id, first.id]);
  });
});
