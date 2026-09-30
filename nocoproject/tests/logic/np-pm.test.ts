// @vitest-environment node
/**
 * The project manager agent (iteration-4 contract §C) on a real PostgreSQL: agent `kind` / `reasoningEffort`
 * (validation, claim payload, `MANAGER_NOT_EXECUTOR`), the workspace settings, the conversation (404 / create /
 * idempotent / private to its owner / follows `pmAgentId`), the manager's reads filtered by the asking member's
 * visibility (`MANAGER_ONLY` for other agents), and the retrospective on done with its exclusions and
 * `retrospective_done`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type {
  AgentListItemV4,
  ClaimedRunPhase4Extras,
  IssueV4,
  PmConversationResponse,
  WorkspaceSettingsViewV4,
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
  triggerRows,
  type Fixture,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  agentApi4,
  browserApi4,
  createKindAgent,
  type ApiCall,
} from './np-iter4-harness.ts';

const opened = await openNpTestDatabase('np_t_pm');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-pm] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let alice: ApiCall;
let bob: ApiCall;
let carol: ApiCall;
let coderRuntime: Fixture;
let pmRuntime: Fixture;
let coder: string;
let manager: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'member');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'owner');
  alice = browserApi4(services, ALICE);
  bob = browserApi4(services, BOB);
  carol = browserApi4(services, CAROL);
  coderRuntime = await registerRuntime(services, ALICE);
  pmRuntime = await registerRuntime(services, CAROL, 'daemon-pm');
  coder = await createKindAgent(
    services,
    ALICE,
    coderRuntime.runtimeId,
    'Coder',
    'coder',
  );
  manager = await createKindAgent(
    services,
    CAROL,
    pmRuntime.runtimeId,
    'PM',
    'manager',
    'high',
  );
});

type Data<T> = { data: T };

async function setPm(agentId: string | null = manager): Promise<void> {
  await services.workspaceSettings.update(CAROL, {
    pmAgentId: agentId,
    retrospectiveOnDone: true,
  });
}

async function parsedActivities(issueId: string, action: string) {
  const found = await rows(
    db!,
    'activities',
    'issue_id = ? AND action = ? ORDER BY created_at, id',
    [issueId, action],
  );
  return found.map((row) =>
    typeof row.details === 'string'
      ? (JSON.parse(row.details) as Record<string, unknown>)
      : (row.details as Record<string, unknown>),
  );
}

describe.skipIf(!db)('agent kind and reasoning effort (PostgreSQL)', () => {
  it('validates, lists and changes them', async () => {
    const listed = await carol<Data<AgentListItemV4[]>>('GET', '/np/agents');
    expect(
      listed.body.data.map((agent) => [
        agent.name,
        agent.kind,
        agent.reasoningEffort,
      ]),
    ).toEqual([
      ['Coder', 'coder', null],
      ['PM', 'manager', 'high'],
    ]);
    const base = {
      name: 'X',
      instructions: '',
      runtimeId: pmRuntime.runtimeId,
      provider: 'echo',
    };
    const badKind = await carol('POST', '/np/agents', {
      ...base,
      kind: 'boss',
    });
    expect(badKind.status).toBe(400);
    expect(badKind.body.code).toBe('INVALID_KIND');
    const badEffort = await carol('POST', '/np/agents', {
      ...base,
      reasoningEffort: 'extreme',
    });
    expect(badEffort.body.code).toBe('INVALID_REASONING_EFFORT');
    const patched = await carol<Data<AgentListItemV4>>(
      'PATCH',
      `/np/agents/${manager}`,
      { reasoningEffort: null, configurationRevision: 1 },
    );
    expect(patched.body.data).toMatchObject({
      kind: 'manager',
      reasoningEffort: null,
    });
  });

  it('refuses a project manager as the executor of ordinary issues', async () => {
    const created = await alice('POST', '/np/issues', {
      title: 'Task',
      executor: { type: 'agent', id: manager },
    });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('MANAGER_NOT_EXECUTOR');
    const issue = (await services.issues.create(ALICE, {
      title: 'Task',
    })) as IssueV4;
    const patched = await alice('PATCH', `/np/issues/${issue.id}`, {
      executor: { type: 'agent', id: manager },
      revision: issue.revision,
    });
    expect(patched.body.code).toBe('MANAGER_NOT_EXECUTOR');
    const batch = await alice<
      Data<{ drafts: { validation: { errors: string[] } }[] }>
    >('POST', '/np/intake/batches', {
      source: 'paste',
      rawContent: 'One task',
    });
    const batchId = (batch.body.data as unknown as { batch: { id: string } })
      .batch.id;
    const drafts = await alice<
      Data<{ drafts: { validation: { errors: string[] } }[] }>
    >('PUT', `/np/intake/batches/${batchId}/drafts`, {
      drafts: [
        {
          position: 1,
          parentPosition: null,
          fields: { title: 'One', executor: { type: 'agent', id: manager } },
        },
      ],
    });
    expect(drafts.body.data.drafts[0]!.validation.errors).toContain(
      'the agent needs issue.execute',
    );
  });
});

describe.skipIf(!db)('workspace settings (PostgreSQL)', () => {
  it('validates pmAgentId, defaultProcess and retrospectiveOnDone', async () => {
    const view = await bob<Data<WorkspaceSettingsViewV4>>(
      'GET',
      '/np/settings',
    );
    expect(view.body.data).toMatchObject({
      defaultProcess: 'auto',
      pmAgentId: null,
      retrospectiveOnDone: true,
    });
    expect(
      (await bob('PATCH', '/np/settings', { pmAgentId: manager })).status,
    ).toBe(403);
    for (const pmAgentId of ['missing'])
      expect(
        (await carol('PATCH', '/np/settings', { pmAgentId })).body.code,
      ).toBe('INVALID_PM_AGENT');
    expect(
      (await carol('PATCH', '/np/settings', { defaultProcess: 'sometimes' }))
        .status,
    ).toBe(400);
    expect(
      (await carol('PATCH', '/np/settings', { retrospectiveOnDone: 'yes' }))
        .status,
    ).toBe(400);
    const saved = await carol<Data<WorkspaceSettingsViewV4>>(
      'PATCH',
      '/np/settings',
      {
        pmAgentId: manager,
        defaultProcess: 'design_first',
        retrospectiveOnDone: false,
      },
    );
    expect(saved.body.data).toMatchObject({
      pmAgentId: manager,
      defaultProcess: 'design_first',
      retrospectiveOnDone: false,
    });
    const cleared = await carol<Data<WorkspaceSettingsViewV4>>(
      'PATCH',
      '/np/settings',
      { pmAgentId: null },
    );
    expect(cleared.body.data.pmAgentId).toBeNull();
  });
});

describe.skipIf(!db)('project manager conversation (PostgreSQL)', () => {
  it('needs a project manager, finds or creates one per member, privately', async () => {
    // NP-183: GET only finds the latest conversation; creating one needs a project manager.
    expect((await alice('GET', '/np/pm/conversation')).status).toBe(404);
    const unset = await alice('POST', '/np/pm/conversation');
    expect(unset.status).toBe(409);
    await setPm();
    const none = await alice('GET', '/np/pm/conversation');
    expect(none.status).toBe(404);
    const created = await alice<Data<PmConversationResponse>>(
      'POST',
      '/np/pm/conversation',
    );
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ agentId: manager });
    const { issueId } = created.body.data;
    expect(
      (await alice<Data<PmConversationResponse>>('POST', '/np/pm/conversation'))
        .body.data.issueId,
    ).toBe(issueId);
    expect(
      (await alice<Data<PmConversationResponse>>('GET', '/np/pm/conversation'))
        .body.data.issueId,
    ).toBe(issueId);
    const [row] = await rows(db!, 'issues', 'id = ?', [issueId]);
    expect(row).toMatchObject({
      // NP-183: untitled until the first message, and no NP-n number.
      title: '',
      number: null,
      identifier: null,
      origin_type: 'pm',
      execution_mode: 'session',
      executor_type: 'agent',
      executor_id: manager,
      owner_user_id: ALICE.id,
      project_id: null,
      process: 'direct',
      status_key: 'todo',
    });
    expect(await runRows(db!)).toHaveLength(0);

    // Private to its owner: 404 for others, left out of their lists.
    expect((await bob('GET', `/np/issues/${issueId}`)).status).toBe(404);
    const bobList = await bob<{ data: { id: string }[] }>('GET', '/np/issues');
    expect(bobList.body.data.map((item) => item.id)).not.toContain(issueId);
    const aliceList = await alice<{ data: { id: string }[] }>(
      'GET',
      '/np/issues',
    );
    // NP-183: conversations are not tasks; their owner's lists leave them out too.
    expect(aliceList.body.data.map((item) => item.id)).not.toContain(issueId);
    const bobs = await bob<Data<PmConversationResponse>>(
      'POST',
      '/np/pm/conversation',
    );
    expect(bobs.body.data.issueId).not.toBe(issueId);

    // A comment asks the manager, acting for the member.
    await alice('POST', `/np/issues/${issueId}/comments`, {
      content: '哪些任务卡住了？',
    });
    const [run] = await runRows(db!);
    expect(run).toMatchObject({
      agent_id: manager,
      actor_user_id: ALICE.id,
      subject_id: issueId,
    });
    expect((await triggerRows(db!, String(run!.id)))[0]?.type).toBe('comment');

    // NP-183: a new system project manager takes new conversations; this one stays with its agent.
    const second = await createKindAgent(
      services,
      CAROL,
      pmRuntime.runtimeId,
      'PM 2',
      'manager',
    );
    await setPm(second);
    const kept = await alice<Data<PmConversationResponse>>(
      'POST',
      '/np/pm/conversation',
    );
    expect(kept.body.data).toEqual({
      issueId,
      identifier: '',
      agentId: manager,
    });
  });
});

describe.skipIf(!db)("the manager's reads (PostgreSQL)", () => {
  it('sees what the asking member may see, and only managers may ask', async () => {
    await setPm();
    const web = await services.projects.create(BOB, { name: 'Web' });
    const secret = await services.projects.create(CAROL, {
      name: 'Secret',
      visibility: 'members',
    });
    const webIssue = await services.issues.create(BOB, {
      title: 'Web task',
      projectId: web.id,
    });
    const mine = await services.issues.create(ALICE, {
      title: 'Alice task',
      projectId: web.id,
    });
    const hidden = await services.issues.create(CAROL, {
      title: 'Secret task',
      projectId: secret.id,
    });
    await services.knowledge.create(CAROL, {
      title: 'Handbook',
      content: 'x',
    });
    await services.knowledge.create(CAROL, {
      projectId: secret.id,
      title: 'Secret doc',
      content: 'x',
    });
    const bobConversation = await services.pm.conversation(BOB, true);
    await db!.knex
      .withSchema(db!.schema)
      .table('inbox_items')
      .insert(
        [ALICE, BOB].map((user, index) => ({
          id: `ib-${index}`,
          user_id: user.id,
          kind: 'decision',
          type: 'review_requested',
          issue_id: webIssue.id,
          title: 't',
          body: 'b',
          count: 1,
          dedupe_key: `k-${index}`,
          created_at: new Date(),
          updated_at: new Date(),
        })),
      );
    const { issueId } = await services.pm.conversation(ALICE, true);
    await services.comments.create(ALICE, issueId, { content: 'Status?' });
    const claimed = await claimOne(services, CAROL, pmRuntime);
    expect((claimed as unknown as ClaimedRunPhase4Extras).agent).toMatchObject({
      kind: 'manager',
      reasoningEffort: 'high',
    });
    const pm = agentApi4(services, claimed!.token);

    const projects = await pm<Data<{ name: string }[]>>('GET', '/pm/projects');
    expect(projects.body.data.map((project) => project.name)).toEqual(['Web']);
    const issues = await pm<{ data: { id: string }[]; nextCursor: null }>(
      'GET',
      '/pm/issues',
    );
    const ids = issues.body.data.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([webIssue.id, mine.id]));
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(bobConversation.issueId);
    expect(issues.body.nextCursor).toBeNull();
    const own = await pm<{ data: { id: string }[] }>(
      'GET',
      '/pm/issues?ownerUserId=me',
    );
    expect(own.body.data.map((item) => item.id)).toEqual([mine.id]);
    expect(
      (await pm<{ data: unknown[] }>('GET', '/pm/issues?updatedSince=7d')).body
        .data.length,
    ).toBeGreaterThan(0);
    expect(
      (await pm('GET', '/pm/issues?updatedSince=2999-01-01T00:00:00Z')).body,
    ).toMatchObject({ data: [] });
    expect((await pm('GET', '/pm/issues?updatedSince=soon')).body.code).toBe(
      'INVALID_QUERY',
    );
    expect((await pm('GET', `/pm/issues/${hidden.identifier}`)).status).toBe(
      404,
    );
    const detail = await pm<
      Data<{
        issue: { id: string; designProposal: unknown; process: string };
        comments: unknown[];
        activities: unknown[];
        runs: unknown[];
        pullRequests: unknown[];
        subtasks: unknown[];
        usage: { inputTokens: number };
      }>
    >('GET', `/pm/issues/${webIssue.identifier}`);
    expect(detail.body.data.issue).toMatchObject({
      id: webIssue.id,
      designProposal: null,
      process: 'direct',
    });
    expect(Object.keys(detail.body.data).sort()).toEqual([
      'activities',
      'comments',
      'issue',
      'pullRequests',
      'runs',
      'subtasks',
      'usage',
    ]);
    const inbox = await pm<{ data: { id: string }[]; unread: unknown }>(
      'GET',
      '/pm/inbox',
    );
    expect(inbox.body.data.map((item) => item.id)).toEqual(['ib-0']);
    const metrics = await pm<Data<{ adoption: unknown }>>('GET', '/pm/metrics');
    expect(metrics.body.data.adoption).toBeDefined();
    const knowledge = await pm<Data<{ title: string }[]>>(
      'GET',
      '/pm/knowledge',
    );
    expect(knowledge.body.data.map((doc) => doc.title)).toEqual(['Handbook']);
    // The normal agent API does not reach another member's conversation either.
    expect((await pm('GET', `/issues/${bobConversation.issueId}`)).status).toBe(
      404,
    );

    await services.issues.create(ALICE, {
      title: 'Coded',
      executor: { type: 'agent', id: coder },
    });
    const coderRun = await claimOne(services, ALICE, coderRuntime);
    const denied = await agentApi4(services, coderRun!.token)(
      'GET',
      '/pm/projects',
    );
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('CAPABILITY_DENIED');
  });
});

describe.skipIf(!db)('retrospective (PostgreSQL)', () => {
  async function doneBy(issue: IssueV4) {
    const current = (await services.issueQueries.detail(ALICE, issue.id)).issue;
    await services.issues.update(ALICE, issue.id, {
      statusKey: 'done',
      revision: current.revision,
    });
  }

  it('asks the manager for a retrospective when an agent-executed issue is done', async () => {
    await setPm();
    const issue = (await services.issues.create(ALICE, {
      title: 'Ship it',
      executor: { type: 'agent', id: coder },
    })) as IssueV4;
    await doneBy(issue);
    const [retro] = await runRows(db!, `agent_id = '${manager}'`);
    expect(retro).toMatchObject({
      subject_id: issue.id,
      thread_scope: 'retro',
      actor_user_id: ALICE.id,
      status: 'queued',
    });
    const [trigger] = await triggerRows(db!, String(retro!.id));
    expect(trigger?.type).toBe('retrospective');

    const claimed = await claimOne(services, CAROL, pmRuntime);
    expect(claimed!.triggers.map((item) => item.type)).toEqual([
      'retrospective',
    ]);
    const pm = agentApi4(services, claimed!.token);
    expect((await pm('GET', `/pm/issues/${issue.identifier}`)).status).toBe(
      200,
    );
    const inboxBefore = await rows(db!, 'inbox_items');
    const note = await pm<Data<{ id: string }>>(
      'POST',
      `/issues/${issue.id}/comments`,
      { content: '/note 总结：一次通过，无返工。' },
    );
    expect(note.status).toBe(201);
    // The manager's note notifies nobody.
    expect(await rows(db!, 'inbox_items')).toHaveLength(inboxBefore.length);
    expect(await parsedActivities(issue.id, 'retrospective_done')).toEqual([]);
    await services.runs.complete(claimed!.run.id, { workDir: '/tmp/pm' });
    expect(await parsedActivities(issue.id, 'retrospective_done')).toEqual([
      { commentId: note.body.data.id, runId: claimed!.run.id },
    ]);
  });

  it('skips issues no agent worked on, conversations, and a disabled setting', async () => {
    await setPm();
    const manual = (await services.issues.create(ALICE, {
      title: 'By hand',
    })) as IssueV4;
    await doneBy(manual);
    const { issueId } = await services.pm.conversation(ALICE, true);
    const conversation = (await services.issueQueries.detail(ALICE, issueId))
      .issue as unknown as IssueV4;
    await doneBy(conversation);
    await services.workspaceSettings.update(CAROL, {
      retrospectiveOnDone: false,
    });
    const coded = (await services.issues.create(ALICE, {
      title: 'Coded',
      executor: { type: 'agent', id: coder },
    })) as IssueV4;
    await doneBy(coded);
    expect(await runRows(db!, `agent_id = '${manager}'`)).toEqual([]);
  });
});
