// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  claimOne,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  setRole,
} from './np-harness.ts';
import { agentApi4 } from './np-iter4-harness.ts';
import type { NpServices } from '../../server/modules/services.ts';
import { AGENT_CAPABILITIES } from '../../server/modules/shared/protocol.capabilities.ts';
import { routeCapability } from '../../server/modules/run/agent-capability-routes.ts';
const opened = await openNpTestDatabase('np_t_configuration');
const skipped = 'skip' in opened;
if (skipped) console.warn(opened.skip);
const db = opened as Exclude<typeof opened, { skip: string }>;
let services: NpServices;
afterAll(() => (skipped ? undefined : db.close()));
beforeEach(async () => {
  if (skipped) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
});
async function setup(
  capabilities = [
    'context.read',
    'comment.create',
  ] as readonly (typeof AGENT_CAPABILITIES)[number][],
) {
  const runtime = await registerRuntime(services, ALICE);
  const agent = await services.agents.create(ALICE, {
    name: 'Any profession',
    instructions: 'Only answer; never split.',
    provider: 'echo',
    runtimeType: 'computer',
    runtimeId: runtime.runtimeId,
    capabilities,
    kind: 'coder',
  });
  // An ordinary issue the configured agent executes (NP-183: conversations take project manager type agents only,
  // whose capabilities are fixed). Set directly: the agent may lack issue.execute on purpose.
  const issue = await services.issues.create(ALICE, { title: 'Configured' });
  await db.knex
    .withSchema(db.schema)
    .table('issues')
    .where({ id: issue.id })
    .update({ executor_type: 'agent', executor_id: agent.id });
  const conversation = { issueId: issue.id };
  await services.comments.create(ALICE, conversation.issueId, {
    content: 'Please split this into subtasks.',
  });
  const run = await claimOne(services, ALICE, runtime);
  if (!run) throw new Error('No run');
  const auth = await services.runTokens.verify(run.token);
  if (!auth) throw new Error('No auth');
  return {
    agent,
    runtime,
    conversation,
    run,
    auth,
    api: agentApi4(services, run.token),
  };
}
describe.skipIf(skipped)('configured agent capabilities', () => {
  it('denies subtask writes without side effects, independently of kind or instructions', async () => {
    const { auth, api } = await setup();
    const before = await db.knex
      .withSchema(db.schema)
      .table('issues')
      .count('* as count')
      .first();
    for (const executor of ['none', 'self', 'unrelated']) {
      const result = await api('POST', '/issues', {
        title: 'Not created',
        executor,
      });
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('CAPABILITY_DENIED');
      await expect(
        services.agentIssues.create(auth, { title: 'No', executor }),
      ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    }
    expect(
      await db.knex
        .withSchema(db.schema)
        .table('issues')
        .count('* as count')
        .first(),
    ).toEqual(before);
  });
  it('denies every ungranted write route before validating payloads', async () => {
    const { api, conversation } = await setup();
    const id = conversation.issueId;
    const routes = [
      ['POST', `/issues/${id}/status`],
      ['POST', `/issues/${id}/design-proposal`],
      ['POST', `/issues/${id}/pull-requests`],
      ['POST', `/issues/${id}/dependencies`],
      ['DELETE', `/issues/${id}/dependencies/other`],
      ['PATCH', `/issues/${id}/checklists/todo/items/a`],
      ['POST', '/knowledge/proposals'],
      ['POST', '/workflows/proposals'],
    ];
    for (const [method, path] of routes) {
      const response = await api(method!, path!, {});
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CAPABILITY_DENIED');
    }
  });
  it('allows an explicitly granted action, and immediately honors revocation', async () => {
    const { agent, auth } = await setup([
      'context.read',
      'comment.create',
      'subtask.create',
    ]);
    expect(
      (await services.agentIssues.create(auth, { title: 'Allowed' })).issue
        .title,
    ).toBe('Allowed');
    await services.agents.update(ALICE, agent.id, {
      configurationRevision: agent.configurationRevision,
      capabilities: ['context.read', 'comment.create'],
    });
    await expect(
      services.agentIssues.create(auth, { title: 'Denied' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });
  it('does not grant running tokens a newly added capability and preserves instructions', async () => {
    const { agent, auth } = await setup();
    const next = await services.agents.update(ALICE, agent.id, {
      configurationRevision: agent.configurationRevision,
      capabilities: ['context.read', 'comment.create', 'subtask.create'],
      name: 'Project manager',
    });
    expect(next.instructions).toBe(agent.instructions);
    await expect(
      services.agentIssues.create(auth, { title: 'Denied' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      services.agents.update(ALICE, agent.id, {
        configurationRevision: agent.configurationRevision,
        instructions: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CONFLICT' });
    await expect(
      services.agents.update(BOB, agent.id, {
        configurationRevision: next.configurationRevision,
        capabilities: AGENT_CAPABILITIES,
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });
  it('requires workspace.read for cross-project queries and replies with current token', async () => {
    const { api, conversation } = await setup();
    expect((await api('GET', '/pm/projects')).status).toBe(403);
    expect(
      (
        await api('POST', `/issues/${conversation.issueId}/comments`, {
          content: 'I can provide advice.',
        })
      ).status,
    ).toBe(201);
  });
  it('gives no work to a CLI that does not apply agent configuration', async () => {
    const response = await services.runtimes.register(ALICE.id!, {
      daemonId: 'old-cli',
      deviceName: 'old',
      version: '0.3.2',
      protocolVersion: 1,
      runtimes: [
        {
          provider: 'echo',
          version: '1',
          capabilities: { resume: true, steering: false },
        },
      ],
    });
    const runtimeId = response.runtimes[0]!.id;
    await expect(
      services.claims.claim(
        ALICE.id!,
        { daemonId: 'old-cli', slots: [{ runtimeId, free: 1 }] },
        'http://test',
      ),
    ).resolves.toMatchObject({
      runs: [],
      compatibility: { status: 'unsupported', reason: 'daemonTooOld' },
    });
  });
  it('records the run configuration and invalidates a session on configuration change', async () => {
    const { agent, run, runtime, conversation } = await setup();
    const detail = await services.runQueries.detail(run.run.id);
    expect(detail.configurationSnapshot).toMatchObject({
      instructions: agent.instructions,
      configurationRevision: 1,
    });
    await services.runs.complete(run.run.id, {
      providerSessionId: 'previous-session',
      workDir: '/tmp/configuration-test',
    });
    await services.agents.update(ALICE, agent.id, {
      configurationRevision: 1,
      instructions: 'New duties',
    });
    await services.comments.create(ALICE, conversation.issueId, {
      content: 'New request',
    });
    const next = await claimOne(services, ALICE, runtime);
    expect(next?.session.fresh).toBe(true);
    expect(next?.session.providerSessionId).toBeNull();
    expect(next?.agent.instructions).toBe('New duties');
  });
  it('invalidates a session when a bound skill changes without an agent edit', async () => {
    const { agent, run, runtime, conversation } = await setup();
    const skill = await services.skills.create(ALICE, {
      name: 'Review',
      content: 'Original method',
    });
    await services.runs.complete(run.run.id, {
      providerSessionId: 'first',
      workDir: '/tmp/config-test',
    });
    const configured = await services.agents.update(ALICE, agent.id, {
      configurationRevision: 1,
      skillIds: [skill.skill.id],
    });
    await services.comments.create(ALICE, conversation.issueId, {
      content: 'Use the skill',
    });
    const next = (await claimOne(services, ALICE, runtime))!;
    await services.runs.complete(next.run.id, {
      providerSessionId: 'skill-session',
      workDir: '/tmp/config-test',
    });
    await services.skills.putFiles(ALICE, skill.skill.id, [
      { path: 'method.md', content: 'A revised method' },
    ]);
    await services.comments.create(ALICE, conversation.issueId, {
      content: 'Use the updated method',
    });
    const changed = (await claimOne(services, ALICE, runtime))!;
    expect(changed.agent.configurationRevision).toBe(
      configured.configurationRevision,
    );
    expect(changed.session.fresh).toBe(true);
    expect(changed.session.providerSessionId).toBeNull();
  });
  it('rejects forged direct-service run scope', async () => {
    const { auth } = await setup([
      'context.read',
      'comment.create',
      'subtask.create',
    ]);
    await expect(
      services.agentIssues.create(
        { ...auth, actorUserId: BOB.id! },
        { title: 'No' },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      services.agentIssues.create(
        { ...auth, issueId: 'other' },
        { title: 'No' },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });
  it('saves independently selected entry agents and rejects a stale entry version', async () => {
    const { runtime } = await setup();
    const agent = await services.agents.create(ALICE, {
      name: 'Project manager',
      instructions: 'Answer.',
      runtimeId: runtime.runtimeId,
      provider: 'echo',
      runtimeType: 'computer',
      kind: 'manager',
    });
    const other = await services.agents.create(ALICE, {
      name: 'Completion assistant',
      instructions: 'Review',
      runtimeId: runtime.runtimeId,
      provider: 'echo',
      runtimeType: 'computer',
    });
    const current = await services.workspaceSettings.view(ALICE);
    const entries = current.agentEntries!;
    const saved = await services.workspaceSettings.update(ALICE, {
      agentEntries: {
        ...entries,
        conversation: {
          ...entries.conversation,
          name: 'Ask us',
          agentId: agent.id,
        },
        completion: {
          ...entries.completion,
          agentId: other.id,
          enabled: true,
          instructions: 'Write a note.',
        },
      },
    });
    expect(saved.agentEntries?.conversation.agentId).toBe(agent.id);
    expect(saved.agentEntries?.completion.agentId).toBe(other.id);
    await expect(
      services.workspaceSettings.update(ALICE, { agentEntries: entries }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CONFLICT' });
  });
  it('denies unmapped endpoints and maps checklist mutation explicitly', () => {
    expect(routeCapability('POST', '/np/agent/new-write')).toBeUndefined();
    expect(routeCapability('GET', '/np/agent/new-read')).toBeUndefined();
    expect(
      routeCapability('PATCH', '/np/agent/issues/a/checklists/todo/items/x'),
    ).toBe('checklist.write');
  });
});
