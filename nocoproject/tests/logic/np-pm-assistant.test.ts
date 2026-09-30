// @vitest-environment node
/**
 * The project manager assistant on a real PostgreSQL (NP-183, protocol-pm-assistant.md §13): several private
 * conversations per member (numbers, titles, archive, search, isolation, exclusion from lists), direct writes in the
 * asker's name (`via = 'pm'`, the budget and every `PLAN_REQUIRED` reason, what the asker may not do, comments that
 * never start a run, `NOT_CONVERSATION_RUN`), the page context, personal project managers (eligibility, copy from the
 * default, fallback and restore), the daemon version gate and the executor roster.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type {
  PmActResult,
  PmAgentChoice,
  PmConversationDetail,
  PmConversationPage,
  PmRosterAgent,
} from '../../server/modules/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../server/modules/shared/protocol.ts';
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

const opened = await openNpTestDatabase('np_t_pm_assistant');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-pm-assistant] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

type Data<T> = { data: T };

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
  );
  await services.workspaceSettings.update(CAROL, { pmAgentId: manager });
});

async function conversation(
  as: ApiCall,
  body: Record<string, unknown> = {},
): Promise<PmConversationDetail> {
  const created = await as<Data<PmConversationDetail>>(
    'POST',
    '/np/pm/conversations',
    body,
  );
  expect(created.status).toBe(201);
  return created.body.data;
}

/** Alice asks in a new conversation; the project manager's run is claimed. */
async function askedRun(message = 'Help me plan') {
  const detail = await conversation(alice);
  await alice('POST', `/np/issues/${detail.id}/comments`, { content: message });
  const claimed = await claimOne(services, CAROL, pmRuntime);
  if (!claimed) throw new Error('No conversation run was claimed');
  return { detail, claimed, pm: agentApi4(services, claimed.token) };
}

async function activitiesOf(issueId: string, action: string) {
  return (
    await rows(
      db!,
      'activities',
      'issue_id = ? AND action = ? ORDER BY created_at, id',
      [issueId, action],
    )
  ).map((row) =>
    typeof row.details === 'string'
      ? (JSON.parse(row.details) as Record<string, unknown>)
      : (row.details as Record<string, unknown>),
  );
}

async function allowPersonal(on = true): Promise<void> {
  const current = await services.workspaceSettings.view(CAROL);
  const entries = current.agentEntries!;
  await services.workspaceSettings.update(CAROL, {
    agentEntries: {
      ...entries,
      conversation: { ...entries.conversation, allowPersonal: on },
    },
  });
}

describe.skipIf(!db)('conversations (PostgreSQL)', () => {
  it('keeps several private, unnumbered conversations per member', async () => {
    const first = await conversation(alice);
    const second = await conversation(alice, { title: 'Release' });
    expect(first).toMatchObject({
      identifier: null,
      titleSource: 'auto',
      title: '',
    });
    expect(second).toMatchObject({ titleSource: 'user', title: 'Release' });
    expect(first.agent).toMatchObject({ id: manager, source: 'system' });

    // The first message names an untitled conversation and moves it to the top.
    await alice('POST', `/np/issues/${first.id}/comments`, {
      content: '## Which tasks are stuck this week?',
    });
    const page = await alice<PmConversationPage>('GET', '/np/pm/conversations');
    expect(page.body.data.map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(page.body.data[0]?.title).toBe('Which tasks are stuck this week');

    // Search covers titles and messages; archived ones are listed apart.
    const found = await alice<PmConversationPage>(
      'GET',
      '/np/pm/conversations?q=stuck',
    );
    expect(found.body.data.map((item) => item.id)).toEqual([first.id]);
    await alice('PATCH', `/np/pm/conversations/${second.id}`, {
      archived: true,
    });
    const active = await alice<PmConversationPage>(
      'GET',
      '/np/pm/conversations',
    );
    expect(active.body.data.map((item) => item.id)).toEqual([first.id]);
    const archived = await alice<PmConversationPage>(
      'GET',
      '/np/pm/conversations?archived=true',
    );
    expect(archived.body.data.map((item) => item.id)).toEqual([second.id]);

    // Nobody else sees them, and no list shows them, not even to their owner.
    expect((await bob('GET', `/np/pm/conversations/${first.id}`)).status).toBe(
      404,
    );
    expect((await bob('GET', `/np/issues/${first.id}`)).status).toBe(404);
    expect(
      (await bob<PmConversationPage>('GET', '/np/pm/conversations')).body.data,
    ).toEqual([]);
    const list = await alice<{ data: { id: string }[] }>('GET', '/np/issues');
    expect(list.body.data.map((item) => item.id)).not.toContain(first.id);
    const [row] = await rows(db!, 'issues', 'id = ?', [first.id]);
    expect(row).toMatchObject({ number: null, identifier: null });
    // Nothing on a conversation notifies anyone.
    expect(await rows(db!, 'inbox_items', 'issue_id = ?', [first.id])).toEqual(
      [],
    );
  });

  it('lets the agent title a conversation until the member renames it', async () => {
    const { detail, pm } = await askedRun();
    const titled = await pm<Data<PmConversationDetail>>(
      'POST',
      '/pm/conversation/title',
      {
        title: 'Release planning',
      },
    );
    expect(titled.body.data).toMatchObject({
      title: 'Release planning',
      titleSource: 'agent',
    });
    await alice('PATCH', `/np/pm/conversations/${detail.id}`, {
      title: 'Mine',
    });
    const locked = await pm('POST', '/pm/conversation/title', {
      title: 'Again',
    });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('TITLE_LOCKED');
  });

  it('keeps the page context the author may see, and refuses a malformed one', async () => {
    const secret = await services.projects.create(CAROL, {
      name: 'Secret',
      visibility: 'members',
    });
    const hidden = await services.issues.create(CAROL, {
      title: 'Hidden',
      projectId: secret.id,
    });
    const visible = await services.issues.create(ALICE, { title: 'Visible' });
    const detail = await conversation(alice);
    const bad = await alice('POST', `/np/issues/${detail.id}/comments`, {
      content: 'x',
      context: { route: '/issues', items: 'all' },
    });
    expect(bad.body.code).toBe('INVALID_CONTEXT');
    const sent = await alice<
      Data<{ comment: { context: unknown }; conversation: unknown }>
    >('POST', `/np/issues/${detail.id}/comments`, {
      content: 'What about these?',
      context: {
        route: '/issues',
        items: [
          { type: 'issue', id: visible.id },
          { type: 'issue', id: hidden.id },
        ],
        selection: { text: 'stuck' },
      },
    });
    expect(sent.body.data.comment.context).toEqual({
      route: '/issues',
      items: [
        {
          type: 'issue',
          id: visible.id,
          identifier: visible.identifier,
          title: 'Visible',
        },
      ],
      selection: { text: 'stuck' },
    });
    expect(sent.body.data.conversation).toMatchObject({
      agent: { id: manager },
    });
    const claimed = (await claimOne(services, CAROL, pmRuntime)) as unknown as {
      triggers: { comment?: { context?: { items: unknown[] } } }[];
      issue: { conversation?: { budget: { limit: number } } };
    };
    expect(claimed.triggers[0]?.comment?.context?.items).toHaveLength(1);
    expect(claimed.issue.conversation?.budget).toEqual({ used: 0, limit: 2 });
    // Outside a conversation the context is ignored.
    const plain = await alice<Data<{ comment: { context: unknown } }>>(
      'POST',
      `/np/issues/${visible.id}/comments`,
      {
        content: 'x',
        context: { route: '/x', items: [] },
      },
    );
    expect(plain.body.data.comment.context).toBeNull();
  });
});

describe.skipIf(!db)('direct writes in the asker’s name (PostgreSQL)', () => {
  it('writes as the member, marked as through the project manager', async () => {
    const { detail, claimed, pm } = await askedRun();
    const created = await pm<Data<PmActResult>>('POST', '/pm/act', {
      op: {
        type: 'issue.create',
        params: { title: 'Draft release notes', process: 'direct' },
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.data.budget).toEqual({ used: 1, limit: 2 });
    const issueId = created.body.data.object.id;
    const [row] = await rows(db!, 'issues', 'id = ?', [issueId]);
    expect(row).toMatchObject({
      owner_user_id: ALICE.id,
      created_by_id: ALICE.id,
    });
    const [activity] = await activitiesOf(issueId, 'issue_created');
    expect(activity).toMatchObject({
      via: 'pm',
      runId: claimed.run.id,
      agentId: manager,
      conversationId: detail.id,
    });

    // A comment in the member's name never starts a run, even when it mentions an agent.
    const before = (await runRows(db!)).length;
    const commented = await pm<Data<PmActResult>>('POST', '/pm/act', {
      op: {
        type: 'comment.create',
        params: {
          issue: issueId,
          content: `[@Coder](mention://agent/${coder}) please look`,
        },
      },
    });
    expect(commented.status).toBe(200);
    expect(commented.body.data.budget.used).toBe(1);
    expect(await runRows(db!)).toHaveLength(before);
    const [comment] = await rows(db!, 'comments', 'id = ?', [
      commented.body.data.object.id,
    ]);
    expect(comment).toMatchObject({
      author_type: 'user',
      author_id: ALICE.id,
      via: 'pm',
    });
  });

  it('asks for a plan card whenever the member must confirm', async () => {
    const { pm } = await askedRun();
    const reason = async (op: unknown) => {
      const answer = await pm('POST', '/pm/act', { op });
      expect(answer.status).toBe(409);
      expect(answer.body.code).toBe('PLAN_REQUIRED');
      return (answer.body as { details?: { reason?: string } }).details?.reason;
    };
    const mine = await services.issues.create(ALICE, { title: 'Mine' });
    expect(
      await reason({
        type: 'issue.create',
        params: { title: 'x', executor: { type: 'agent', id: coder } },
      }),
    ).toBe('agentExecutor');
    expect(
      await reason({
        type: 'issue.update',
        params: { issue: mine.id, set: { ownerUserId: BOB.id } },
      }),
    ).toBe('ownerChange');
    expect(
      await reason({
        type: 'issue.status',
        params: { issue: mine.id, statusKey: 'done' },
      }),
    ).toBe('terminal');
    expect(
      await reason({ type: 'project.create', params: { name: 'New' } }),
    ).toBe('planOnly');
    // Assigning the coder through a status move out of backlog would start its run.
    await db!.knex
      .withSchema(db!.schema)
      .table('issues')
      .where({ id: mine.id })
      .update({
        status_key: 'backlog',
        executor_type: 'agent',
        executor_id: coder,
      });
    expect(
      await reason({
        type: 'issue.status',
        params: { issue: mine.id, statusKey: 'todo' },
      }),
    ).toBe('wouldStartRun');
    const [after] = await rows(db!, 'issues', 'id = ?', [mine.id]);
    expect(after?.status_key).toBe('backlog');

    // Two distinct objects per run; writing one of them again is free.
    const one = await services.issues.create(ALICE, { title: 'One' });
    const two = await services.issues.create(ALICE, { title: 'Two' });
    const three = await services.issues.create(ALICE, { title: 'Three' });
    for (const target of [one, two, one])
      expect(
        (
          await pm('POST', '/pm/act', {
            op: {
              type: 'issue.update',
              params: { issue: target.id, set: { priority: 'high' } },
            },
          })
        ).status,
      ).toBe(200);
    expect(
      await reason({
        type: 'issue.update',
        params: { issue: three.id, set: { priority: 'high' } },
      }),
    ).toBe('budget');
  });

  it('honors "always confirm first" and what the member may not do', async () => {
    const secret = await services.projects.create(CAROL, {
      name: 'Secret',
      visibility: 'members',
    });
    const hidden = await services.issues.create(CAROL, {
      title: 'Hidden',
      projectId: secret.id,
    });
    const { pm } = await askedRun();
    const denied = await pm('POST', '/pm/act', {
      op: {
        type: 'issue.update',
        params: { issue: hidden.id, set: { title: 'Mine now' } },
      },
    });
    expect(denied.status).toBe(404);
    const prefs = await alice<Data<{ revision: number }>>(
      'GET',
      '/np/me/preferences',
    );
    await alice('PATCH', '/np/me/preferences', {
      pmConfirmAll: true,
      revision: prefs.body.data.revision,
    });
    const confirm = await pm('POST', '/pm/act', {
      op: { type: 'issue.create', params: { title: 'x' } },
    });
    expect(
      (confirm.body as { details?: { reason?: string } }).details?.reason,
    ).toBe('confirmAll');
  });

  it('refuses every other run', async () => {
    const issue = await services.issues.create(ALICE, { title: 'Task' });
    await alice('POST', `/np/issues/${issue.id}/comments`, {
      content: `[@PM](mention://agent/${manager}) hello`,
    });
    const claimed = await claimOne(services, CAROL, pmRuntime);
    const pm = agentApi4(services, claimed!.token);
    const answer = await pm('POST', '/pm/act', {
      op: { type: 'issue.create', params: { title: 'x' } },
    });
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('NOT_CONVERSATION_RUN');
  });
});

describe.skipIf(!db)('personal project managers (PostgreSQL)', () => {
  it('checks eligibility, copies the default, and falls back and restores', async () => {
    const choice = await alice<Data<PmAgentChoice>>('GET', '/np/me/pm-agent');
    expect(choice.body.data).toMatchObject({
      mode: 'system',
      allowPersonal: false,
      systemAgent: { id: manager },
    });
    const disabled = await alice('POST', '/np/me/pm-agent/copy-from-default', {
      runtimeId: coderRuntime.runtimeId,
    });
    expect(
      (disabled.body as { details?: { reason?: string } }).details?.reason,
    ).toBe('personalDisabled');
    await allowPersonal();
    const foreign = await alice('POST', '/np/me/pm-agent/copy-from-default', {
      runtimeId: pmRuntime.runtimeId,
    });
    expect(
      (foreign.body as { details?: { reason?: string } }).details?.reason,
    ).toBe('foreignRuntime');
    const copied = await alice<
      Data<{ agent: { id: string; kind: string }; choice: PmAgentChoice }>
    >('POST', '/np/me/pm-agent/copy-from-default', {
      runtimeId: coderRuntime.runtimeId,
    });
    expect(copied.status).toBe(201);
    const personal = copied.body.data.agent.id;
    expect(copied.body.data.agent.kind).toBe('manager');
    expect(copied.body.data.choice).toMatchObject({
      mode: 'personal',
      agentId: personal,
    });
    const notOwner = await bob('PUT', '/np/me/pm-agent', {
      revision: 1,
      mode: 'personal',
      agentId: personal,
    });
    expect(
      (notOwner.body as { details?: { reason?: string } }).details?.reason,
    ).toBe('notOwner');
    // It must stay private.
    const agent = await alice<Data<{ configurationRevision: number }>>(
      'GET',
      `/np/agents/${personal}`,
    );
    const opened = await alice('PATCH', `/np/agents/${personal}`, {
      access: 'everyone',
      configurationRevision: agent.body.data.configurationRevision,
    });
    expect(opened.body.code).toBe('PERSONAL_PM_MUST_BE_PRIVATE');

    const detail = await conversation(alice);
    expect(detail.agent).toMatchObject({ id: personal, source: 'personal' });
    // The personal agent's computer is offline: the member switches this conversation to the system default.
    await alice('POST', `/np/issues/${detail.id}/comments`, {
      content: 'Anyone there?',
    });
    const fallback = await alice<Data<PmConversationDetail>>(
      'POST',
      `/np/pm/conversations/${detail.id}/fallback`,
    );
    expect(fallback.body.data.agent).toMatchObject({
      id: manager,
      source: 'fallback',
      personalAvailable: true,
    });
    const moved = await runRows(db!, "status = 'queued'");
    expect(moved.map((run) => run.agent_id)).toEqual([manager]);
    const restored = await alice<Data<PmConversationDetail>>(
      'POST',
      `/np/pm/conversations/${detail.id}/restore`,
    );
    expect(restored.body.data.agent).toMatchObject({
      id: personal,
      source: 'personal',
    });

    // Archived: the next message rebinds the conversation to the system default.
    const now = await alice<Data<{ configurationRevision: number }>>(
      'GET',
      `/np/agents/${personal}`,
    );
    await alice('PATCH', `/np/agents/${personal}`, {
      archived: true,
      configurationRevision: now.body.data.configurationRevision,
    });
    await alice('POST', `/np/issues/${detail.id}/comments`, {
      content: 'Still there?',
    });
    const after = await alice<Data<PmConversationDetail>>(
      'GET',
      `/np/pm/conversations/${detail.id}`,
    );
    expect(after.body.data.agent).toMatchObject({
      id: manager,
      source: 'fallback',
    });
    expect(
      (await activitiesOf(detail.id, 'executor_changed')).map(
        (item) => item.reason,
      ),
    ).toEqual(['pmFallback', 'pmRestore', 'pmAgentUnavailable']);
  });
});

describe.skipIf(!db)('version gate and roster (PostgreSQL)', () => {
  it('leaves conversation runs to new daemons only', async () => {
    const old = await services.runtimes.register(CAROL.id!, {
      daemonId: 'daemon-old',
      deviceName: 'old',
      version: '0.5.1',
      protocolVersion: PROTOCOL_VERSION,
      runtimes: [
        {
          provider: 'echo',
          version: '1.0.0',
          capabilities: { resume: true, steering: false },
        },
      ],
    });
    const oldRuntime = {
      runtimeId: old.runtimes[0]!.id,
      daemonId: 'daemon-old',
    };
    const oldPm = await createKindAgent(
      services,
      CAROL,
      oldRuntime.runtimeId,
      'Old PM',
      'manager',
    );
    await services.workspaceSettings.update(CAROL, { pmAgentId: oldPm });
    const detail = await conversation(alice);
    await alice('POST', `/np/issues/${detail.id}/comments`, {
      content: 'Hello',
    });
    expect(await claimOne(services, CAROL, oldRuntime)).toBeUndefined();
    const notice = await rows(
      db!,
      'inbox_items',
      "type = 'runtime_upgrade_required'",
      [],
    );
    expect(notice).toHaveLength(1);
    // Ordinary work still flows to the old daemon.
    const task = await services.issues.create(CAROL, { title: 'Ordinary' });
    await services.comments.create(CAROL, task.id, {
      content: `[@Old PM](mention://agent/${oldPm}) hi`,
    });
    expect((await claimOne(services, CAROL, oldRuntime))?.issue.id).toBe(
      task.id,
    );
  });

  it('lists executors without other members’ project managers', async () => {
    const mine = await createKindAgent(
      services,
      BOB,
      coderRuntime.runtimeId,
      'Bob PM',
      'manager',
    );
    await db!.knex
      .withSchema(db!.schema)
      .table('agents')
      .where({ id: mine })
      .update({ access: 'ownerOnly' });
    const { pm } = await askedRun();
    const roster = await pm<Data<PmRosterAgent[]>>('GET', '/pm/agents');
    const ids = roster.body.data.map((agent) => agent.id);
    expect(ids).toEqual(expect.arrayContaining([coder, manager]));
    expect(ids).not.toContain(mine);
    const entry = roster.body.data.find((agent) => agent.id === coder)!;
    expect(entry).toMatchObject({
      kind: 'coder',
      canInvoke: true,
      load: { running: 0 },
    });
    expect(entry).not.toHaveProperty('env');
  });
});
