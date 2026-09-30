// @vitest-environment node
/**
 * The params of plan rows and direct writes on a real PostgreSQL (NP-202, protocol-pm-assistant.md §4.2): an
 * `issue.create` row assigns its agent executor and starts the run once the owner executes it; an `issue.update` row
 * changes owner, executor, priority and labels; unknown or misplaced fields are a row's `INVALID_PARAMS`, never a
 * silently dropped field or an `INTERNAL_ERROR`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type {
  PmConversationDetail,
  PmPlan,
  PmPlanRowCheck,
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

const opened = await openNpTestDatabase('np_t_pm_plan_params');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-pm-plan-params] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

type Data<T> = { data: T };
type Refused = { code?: string; details?: { rows: PmPlanRowCheck[] } };

let services: NpServices;
let alice: ApiCall;
let runtime: Fixture;
let coder: string;
let pm: ApiCall;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'member');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'owner');
  alice = browserApi4(services, ALICE);
  runtime = await registerRuntime(services, CAROL, 'daemon-pm');
  const manager = await createKindAgent(
    services,
    CAROL,
    runtime.runtimeId,
    'PM',
    'manager',
  );
  coder = await createKindAgent(
    services,
    CAROL,
    runtime.runtimeId,
    'Coder',
    'coder',
  );
  await services.workspaceSettings.update(CAROL, { pmAgentId: manager });
  const created = await alice<Data<PmConversationDetail>>(
    'POST',
    '/np/pm/conversations',
    {},
  );
  await alice('POST', `/np/issues/${created.body.data.id}/comments`, {
    content: 'Plan it',
  });
  const claimed = await claimOne(services, CAROL, runtime);
  if (!claimed) throw new Error('No conversation run');
  pm = agentApi4(services, claimed.token);
});

async function refusedRows(ops: unknown[]): Promise<PmPlanRowCheck[]> {
  const answer = await pm('POST', '/pm/plans', { title: 'x', ops });
  expect(answer.status).toBe(400);
  const body = answer.body as Refused;
  expect(body.code).toBe('PLAN_INVALID');
  return body.details!.rows;
}

async function execute(ops: unknown[]): Promise<PmPlan> {
  const answer = await pm<Data<PmPlan>>('POST', '/pm/plans', {
    title: 'x',
    ops,
  });
  expect(answer.status).toBe(201);
  const executed = await alice<Data<PmPlan>>(
    'POST',
    `/np/pm/plans/${answer.body.data.id}/execute`,
    { revision: 1 },
  );
  expect(executed.body.data.status).toBe('executed');
  return executed.body.data;
}

describe.skipIf(!db)('plan row params (PostgreSQL)', () => {
  it('issue.create assigns an agent executor, flags the run and starts it when executed', async () => {
    const op = {
      type: 'issue.create',
      params: {
        title: 'Assigned',
        process: 'direct',
        executor: { type: 'agent', id: coder },
      },
    };
    const answer = await pm<Data<PmPlan>>('POST', '/pm/plans', {
      title: 'x',
      ops: [op],
    });
    expect(answer.status).toBe(201);
    const row = answer.body.data.rows[0]!;
    expect(row.flags).toContain('startsRun');
    expect(row.preview).toEqual([
      expect.objectContaining({ agentId: coder, agentName: 'Coder' }),
    ]);
    // A direct write may not assign an agent: that stays the owner's decision.
    const direct = await pm('POST', '/pm/act', { op });
    expect(direct.body.code).toBe('PLAN_REQUIRED');
    const executed = await alice<Data<PmPlan>>(
      'POST',
      `/np/pm/plans/${answer.body.data.id}/execute`,
      { revision: 1 },
    );
    expect(executed.body.data.status).toBe('executed');
    const issueId = executed.body.data.rows[0]!.resultId;
    const [issue] = await rows(db!, 'issues', 'id = ?', [issueId]);
    expect(issue).toMatchObject({ executor_type: 'agent', executor_id: coder });
    const runs = await runRows(db!, "status = 'queued'");
    expect(
      runs.some((run) => run.agent_id === coder && run.subject_id === issueId),
    ).toBe(true);
  });

  it('refuses guessed executor fields on issue.create instead of dropping them', async () => {
    const [check] = await refusedRows([
      {
        type: 'issue.create',
        params: {
          title: 'Guessed',
          executorType: 'agent',
          executorId: coder,
        },
      },
    ]);
    expect(check).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(check!.errorMessage).toContain('params.executorType');
    expect(check!.errorMessage).toContain('executor: {"type"');
    const direct = await pm('POST', '/pm/act', {
      op: {
        type: 'issue.create',
        params: { title: 'Guessed', executorId: coder },
      },
    });
    expect(direct.status).toBe(400);
    expect(direct.body.code).toBe('INVALID_PARAMS');
    expect(await rows(db!, 'issues', "title = 'Guessed'", [])).toEqual([]);
  });

  it('answers malformed issue.update rows with field errors, never INTERNAL_ERROR', async () => {
    const target = await services.issues.create(ALICE, { title: 'Target' });
    const checks = await refusedRows([
      {
        type: 'issue.update',
        params: { issueId: target.id, priority: 'high' },
      },
      {
        type: 'issue.update',
        params: { id: target.id, set: { priority: 'high' } },
      },
      {
        type: 'issue.update',
        params: { issue: target.id, patch: { priority: 'high' } },
      },
      {
        type: 'issue.update',
        params: { issue: target.id, set: { executorAgentId: coder } },
      },
      { type: 'issue.update', params: { issue: target.id, set: {} } },
      {
        type: 'issue.update',
        params: { issue: target.id, set: { executor: { type: 'agent' } } },
      },
    ]);
    expect(checks.map((check) => check.errorCode)).toEqual(
      Array(6).fill('INVALID_PARAMS'),
    );
    expect(checks[0]!.errorMessage).toContain('params.issueId');
    expect(checks[0]!.errorMessage).toContain('put priority under set');
    expect(checks[1]!.errorMessage).toContain('params.issue is required');
    expect(checks[3]!.errorMessage).toContain('params.set.executorAgentId');
    expect(checks[5]!.errorMessage).toContain('params.set.executor must be');
  });

  it('issue.update changes owner, executor, priority and labels and starts the run', async () => {
    const label = await services.labels.create(CAROL, { name: 'backend' });
    const target = await services.issues.create(ALICE, {
      title: 'To assign',
      process: 'direct',
    });
    const plan = await execute([
      {
        type: 'issue.update',
        params: {
          issue: target.identifier,
          set: {
            priority: 'high',
            labelIds: [label.id],
            ownerUserId: BOB.id,
            executor: { type: 'agent', id: coder },
          },
        },
      },
    ]);
    expect(plan.rows[0]).toMatchObject({ status: 'done', resultId: target.id });
    const [issue] = await rows(db!, 'issues', 'id = ?', [target.id]);
    expect(issue).toMatchObject({
      priority: 'high',
      owner_user_id: BOB.id,
      executor_type: 'agent',
      executor_id: coder,
    });
    const labels = await rows(db!, 'issue_label_links', 'issue_id = ?', [
      target.id,
    ]);
    expect(labels.map((row) => row.label_id)).toEqual([label.id]);
    const runs = await runRows(db!, "status = 'queued'");
    expect(
      runs.some(
        (run) => run.agent_id === coder && run.subject_id === target.id,
      ),
    ).toBe(true);
  });
});
