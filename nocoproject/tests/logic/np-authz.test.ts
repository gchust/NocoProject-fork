// @vitest-environment node
/**
 * Application-level authorization (contract §B, §F, §H) and workflow-derived transitions (§C) on a real PostgreSQL:
 * private projects, owner / terminal-status rules, member roles, agent access levels and runtime binding, projects,
 * labels, and a project template that changes the status catalog and agent transitions.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  createAgent,
  claimOne,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  runRows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_authz');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-authz] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let runtimeId: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  await db.knex.raw(
    `DELETE FROM "${db.schema}".workflow_templates WHERE id <> 'default'`,
  );
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  ({ runtimeId } = await registerRuntime(services, ALICE));
});

async function revisionOf(actor: Actor, id: string): Promise<number> {
  return (await services.issueQueries.detail(actor, id)).issue.revision;
}

describe.skipIf(!db)('authorization rules (PostgreSQL)', () => {
  it('hides private projects and their issues from non-members (404), but not from members', async () => {
    const project = await services.projects.create(BOB, {
      name: 'Secret',
      visibility: 'members',
    });
    expect(project).toMatchObject({ leadUserId: BOB.id, memberCount: 1 });
    const issue = await services.issues.create(BOB, {
      title: 'Hidden',
      projectId: project.id,
    });
    await expect(
      services.issueQueries.detail(CAROL, issue.identifier),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      services.projects.get(CAROL, project.id),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await services.issueQueries.list(CAROL, {})).toEqual([]);
    expect(await services.projects.list(CAROL)).toEqual([]);
    await expect(
      services.comments.create(CAROL, issue.id, { content: 'peek' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      services.issues.create(CAROL, { title: 'Sneak', projectId: project.id }),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
    // Owners/admins see everything; adding Carol as a member opens it for her.
    expect(await services.issueQueries.list(ALICE, {})).toHaveLength(1);
    await expect(
      services.projects.addMember(CAROL, project.id, { userId: CAROL.id! }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await services.projects.addMember(BOB, project.id, { userId: CAROL.id! });
    expect(
      (await services.issueQueries.detail(CAROL, issue.id)).project,
    ).toEqual({ id: project.id, name: 'Secret' });
  });

  it('lets only the owner, the project lead or owner/admin reassign the owner or close an issue', async () => {
    const project = await services.projects.create(ALICE, {
      name: 'Open',
      leadUserId: CAROL.id,
    });
    const issue = await services.issues.create(BOB, {
      title: 'Mine',
      projectId: project.id,
    });
    // Carol is a plain member, but the lead of `project`: she may close Bob's issue there, not elsewhere.
    const other = await services.issues.create(ALICE, { title: 'No project' });
    await expect(
      services.issues.update(CAROL, other.id, {
        statusKey: 'done',
        revision: other.revision,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.issues.update(CAROL, other.id, {
        ownerUserId: CAROL.id,
        revision: other.revision,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Non-terminal edits are open to every member who can see the issue.
    const moved = await services.issues.update(CAROL, other.id, {
      statusKey: 'in_progress',
      title: 'Renamed',
      revision: other.revision,
    });
    expect(moved.statusKey).toBe('in_progress');
    const closed = await services.issues.update(CAROL, issue.id, {
      statusKey: 'done',
      revision: issue.revision,
    });
    expect(closed.statusKey).toBe('done');
    const reassigned = await services.issues
      .update(BOB, other.id, {
        ownerUserId: BOB.id,
        revision: await revisionOf(ALICE, other.id),
      })
      .catch((error: unknown) => error);
    expect(reassigned).toMatchObject({ code: 'FORBIDDEN' });
    const byOwner = await services.issues.update(ALICE, other.id, {
      ownerUserId: BOB.id,
      revision: await revisionOf(ALICE, other.id),
    });
    expect(byOwner.ownerUserId).toBe(BOB.id);
  });

  it('enforces member role rules, including the last owner', async () => {
    await expect(
      services.members.updateRole(BOB, CAROL.id!, 'admin'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const admin = await services.members.updateRole(ALICE, BOB.id!, 'admin');
    expect(admin.role).toBe('admin');
    expect(
      (await services.members.updateRole(BOB, CAROL.id!, 'admin')).role,
    ).toBe('admin');
    await expect(
      services.members.updateRole(BOB, CAROL.id!, 'owner'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.members.updateRole(BOB, ALICE.id!, 'member'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.members.updateRole(ALICE, ALICE.id!, 'admin'),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
    await services.members.updateRole(ALICE, CAROL.id!, 'owner');
    expect(
      (await services.members.updateRole(ALICE, ALICE.id!, 'member')).role,
    ).toBe('member');
    await expect(
      services.members.updateRole(ALICE, BOB.id!, 'role' as never),
    ).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    const list = await services.members.list(BOB);
    expect(list.map((member) => [member.userId, member.role]).sort()).toEqual(
      [
        [ALICE.id, 'member'],
        [BOB.id, 'admin'],
        [CAROL.id, 'owner'],
      ].sort(),
    );
  });

  it('bootstraps the first member as owner and later ones as members', async () => {
    await db!.knex.raw(`TRUNCATE "${db!.schema}".members`);
    expect(await services.members.ensure(BOB.id!)).toBe('owner');
    expect(await services.members.ensure(CAROL.id!)).toBe('member');
    expect(await services.members.ensure(BOB.id!)).toBe('owner');
  });

  it('enforces agent access levels on assign, mention and the list', async () => {
    const agentId = await createAgent(services, ALICE, runtimeId, 'Private');
    const issue = await services.issues.create(BOB, { title: 'Needs help' });
    await expect(
      services.issues.update(BOB, issue.id, {
        executor: { type: 'agent', id: agentId },
        revision: issue.revision,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.comments.create(BOB, issue.id, {
        content: `[@Private](mention://agent/${agentId}) help`,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // `/note` comments never trigger, so mentioning there is plain text.
    await services.comments.create(BOB, issue.id, {
      content: `/note [@Private](mention://agent/${agentId})`,
    });
    let [row] = await services.agents.list(BOB);
    expect(row).toMatchObject({
      canInvoke: false,
      canEdit: false,
      ownerName: 'Alice',
    });

    await expect(
      services.agents.update(BOB, agentId, {
        configurationRevision: (await services.agents.get(BOB, agentId))
          .configurationRevision,
        access: 'everyone',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await services.agents.update(ALICE, agentId, {
      configurationRevision: (await services.agents.get(ALICE, agentId))
        .configurationRevision,
      access: 'specificUsers',
      accessUserIds: [BOB.id!],
    });
    [row] = await services.agents.list(BOB);
    expect(row).toMatchObject({
      access: 'specificUsers',
      canInvoke: true,
      accessUserIds: [BOB.id],
    });
    expect((await services.agents.list(CAROL))[0]!.canInvoke).toBe(false);
    const assigned = await services.issues.update(BOB, issue.id, {
      executor: { type: 'agent', id: agentId },
      revision: await revisionOf(BOB, issue.id),
    });
    expect(assigned.executorType).toBe('agent');
    expect(await runRows(db!, `subject_id = '${issue.id}'`)).toHaveLength(1);
  });

  it('binds agents only to own or public runtimes and checks delegation targets', async () => {
    await expect(
      services.agents.create(BOB, {
        name: 'Borrowed',
        instructions: 'x',
        runtimeId,
        provider: 'echo',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.runtimes.setVisibility(BOB, runtimeId, 'public'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const runtime = await services.runtimes.setVisibility(
      ALICE,
      runtimeId,
      'public',
    );
    expect(runtime.visibility).toBe('public');
    const bobs = await services.agents.create(BOB, {
      name: 'Borrowed',
      instructions: 'x',
      runtimeId,
      provider: 'echo',
    });
    expect(bobs).toMatchObject({
      ownerUserId: BOB.id,
      canEdit: true,
      canInvoke: true,
    });
    const alices = await createAgent(services, ALICE, runtimeId, 'Alices');
    await expect(
      services.agents.update(BOB, bobs.id, {
        configurationRevision: (await services.agents.get(BOB, bobs.id))
          .configurationRevision,
        delegationTargetIds: [alices],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.agents.update(BOB, bobs.id, {
        configurationRevision: (await services.agents.get(BOB, bobs.id))
          .configurationRevision,
        delegationTargetIds: [bobs.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DELEGATION' });
    await services.agents.update(ALICE, alices, {
      configurationRevision: (await services.agents.get(ALICE, alices))
        .configurationRevision,
      access: 'everyone',
    });
    const delegating = await services.agents.update(BOB, bobs.id, {
      configurationRevision: (await services.agents.get(BOB, bobs.id))
        .configurationRevision,
      delegationTargetIds: [alices],
    });
    expect(delegating.delegationTargets).toEqual([
      { id: alices, name: 'Alices' },
    ]);
  });

  it('manages projects, members, resources and labels, and unlinks issues when a project is deleted', async () => {
    const project = await services.projects.create(BOB, {
      name: 'Repo work',
      startDate: '2026-10-01',
      priority: 'high',
    });
    const resource = await services.projects.addResource(BOB, project.id, {
      type: 'gitRepo',
      url: 'https://github.com/nocobase/nocoproject.git',
      defaultRef: 'main',
    });
    expect(resource).toMatchObject({ position: 0, defaultRef: 'main' });
    await expect(
      services.projects.addResource(BOB, project.id, {
        type: 'gitRepo',
        url: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_URL' });
    await services.projects.updateResource(BOB, project.id, resource.id, {
      label: 'Main repo',
    });
    const label = await services.labels.create(CAROL, {
      name: 'bug',
      color: 'red',
    });
    await expect(
      services.labels.create(CAROL, { name: 'bug' }),
    ).rejects.toMatchObject({ code: 'LABEL_EXISTS' });
    const issue = await services.issues.create(CAROL, {
      title: 'Tracked',
      projectId: project.id,
      labelIds: [label.id],
      dueDate: '2026-10-31',
    });
    const detail = await services.projects.get(CAROL, project.id);
    expect(detail).toMatchObject({
      leadName: 'Bob',
      priority: 'high',
      startDate: '2026-10-01',
      issueCounts: { total: 1, byStatus: { todo: 1 } },
      resources: [expect.objectContaining({ label: 'Main repo' })],
      workflow: expect.objectContaining({ isDefault: true }),
    });
    expect(
      (await services.issueQueries.list(CAROL, { labelId: label.id })).map(
        (item) => item.labels,
      ),
    ).toEqual([[{ id: label.id, name: 'bug', color: 'red' }]]);
    await expect(
      services.projects.remove(BOB, project.id),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await services.projects.remove(ALICE, project.id);
    const after = await services.issueQueries.detail(CAROL, issue.id);
    expect(after.issue.projectId).toBeNull();
    expect(after.activities.map((item) => item.action)).toContain(
      'project_changed',
    );
    await expect(
      services.issues.update(CAROL, issue.id, {
        dueDate: '2026-02-30',
        revision: after.issue.revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE' });
  });

  it("derives the catalog and agent transitions from the project's workflow template", async () => {
    const definition = {
      statuses: [
        {
          key: 'todo',
          name: 'Todo',
          category: 'unstarted',
          color: 'blue',
          builtIn: true,
        },
        {
          key: 'doing',
          name: 'Doing',
          category: 'started',
          color: 'yellow',
          builtIn: false,
        },
        {
          key: 'done',
          name: 'Done',
          category: 'done',
          color: 'green',
          builtIn: true,
        },
      ],
      transitions: [
        { from: '*', to: '*', actors: ['user'] },
        { from: 'todo', to: 'doing', actors: ['agent'] },
      ],
      childBatchDoneWakesParentExecutor: false,
    };
    await db!.knex.raw(
      `INSERT INTO "${db!.schema}".workflow_templates (id, name, is_default, definition, created_at, updated_at)
       VALUES ('lean', 'Lean', false, ?, now(), now())`,
      [JSON.stringify(JSON.stringify(definition))],
    );
    expect((await services.workflows.list()).map((item) => item.id)).toEqual([
      'default',
      'lean',
    ]);
    const project = await services.projects.create(ALICE, { name: 'Lean' });
    await services.projects.update(ALICE, project.id, { workflowId: 'lean' });
    const issue = await services.issues.create(ALICE, {
      title: 'Lean issue',
      projectId: project.id,
    });
    const detail = await services.issueQueries.detail(ALICE, issue.id);
    expect(detail.statusCatalog).toEqual([
      { key: 'todo', category: 'unstarted', agentWritable: false },
      { key: 'doing', category: 'started', agentWritable: true },
      { key: 'done', category: 'done', agentWritable: false },
    ]);
    expect(detail.agentTransitions).toEqual([{ from: 'todo', to: 'doing' }]);
    await expect(
      services.issues.update(ALICE, issue.id, {
        statusKey: 'in_review',
        revision: issue.revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    const fixture = await registerRuntime(services, ALICE);
    const agentId = await createAgent(
      services,
      ALICE,
      fixture.runtimeId,
      'Dev',
    );
    await services.issues.update(ALICE, issue.id, {
      executor: { type: 'agent', id: agentId },
      revision: issue.revision,
    });
    const claimed = await claimOne(services, ALICE, fixture);
    const agent: Actor = { type: 'agent', id: agentId, runId: claimed!.run.id };
    await expect(
      services.issues.agentSetStatus(agent, issue.id, 'done'),
    ).rejects.toMatchObject({ code: 'TRANSITION_NOT_ALLOWED' });
    expect(
      (await services.issues.agentSetStatus(agent, issue.id, 'doing'))
        .statusKey,
    ).toBe('doing');
    // Issues without a project keep the default template (4 transitions + 5 design-first ones since iteration 4).
    const plain = await services.issues.create(ALICE, { title: 'Plain' });
    expect(
      (await services.issueQueries.detail(ALICE, plain.id)).agentTransitions,
    ).toHaveLength(9);
  });
});
