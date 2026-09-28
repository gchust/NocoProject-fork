// @vitest-environment node
/**
 * Workflow template proposals on a real PostgreSQL (NP-77 方案 §4–§6, stage 2 — the "模板提议" verification items):
 * agents read templates; an invalid definition is 400 with field errors at once; a second pending proposal of the
 * same run is 409; system templates may only be copied; acceptance takes effect at once for the projects on the
 * template, with a revision snapshot; an outdated base is 409 stale; removing a status in use is 409 with counts;
 * decision cards, activities and result notices; rejection with a comment.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  AgentWorkflowListItem,
  InboxAction,
  WorkflowListItemV5,
  WorkflowProposal,
  WorkflowRevision,
  WorkflowValidationDetails,
} from '../../server/modules/shared/protocol.ts';
import { BUILTIN_DEFINITION } from '../../server/modules/issue/status.ts';
import {
  ALICE,
  BOB,
  CAROL,
  openNpTestDatabase,
  rows,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  CODE_REVIEW,
  definitionWith,
  insertTemplate,
  moveTo,
  projectOn,
  secondRun,
  setupWorld,
  world,
} from './np-workflow-harness.ts';

const opened = await openNpTestDatabase('np_t_workflow_proposals');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-workflow-proposals] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  if (db) await setupWorld(db);
});

type Data<T> = { data: T };

async function propose(body: Record<string, unknown>, api = world.agent) {
  return api<Data<WorkflowProposal>>('POST', '/workflows/proposals', body);
}

/** Unresolved `workflow_proposal` cards. */
async function decisionCards(userId: typeof ALICE) {
  return (
    await world.services.inbox.list(userId, { kind: 'decision' })
  ).data.filter(
    (item) => item.type === ('workflow_proposal' as never) && !item.resolvedAt,
  );
}

describe.skipIf(!db)('workflow template proposals (PostgreSQL)', () => {
  it('lets agents read every template with revision, system flag and the run project’s one', async () => {
    const custom = await insertTemplate(definitionWith([CODE_REVIEW]));
    const list = await world.agent<Data<AgentWorkflowListItem[]>>(
      'GET',
      '/workflows',
    );
    expect(list.status).toBe(200);
    const byId = new Map(list.body.data.map((item) => [item.id, item]));
    expect(byId.get('default')).toMatchObject({
      isSystem: true,
      isDefault: true,
      revision: 1,
      usedByRunProject: true,
    });
    expect(byId.get('software-with-approval')?.isSystem).toBe(true);
    expect(byId.get(custom)).toMatchObject({
      isSystem: false,
      usedByRunProject: false,
      projectCount: 0,
    });
    const one = await world.agent<Data<AgentWorkflowListItem>>(
      'GET',
      `/workflows/${custom}`,
    );
    expect(one.body.data.definition.statuses.at(-1)?.key).toBe('code_review');
    expect((await world.agent('GET', '/workflows/nope')).status).toBe(404);
    expect((await world.agent('GET', '/workflows', undefined)).status).toBe(
      200,
    );
  });

  it('refuses invalid definitions with every field error, and system template edits', async () => {
    const broken = {
      ...BUILTIN_DEFINITION,
      statuses: BUILTIN_DEFINITION.statuses.filter(
        (status) => status.key !== 'blocked',
      ),
      transitions: [
        ...BUILTIN_DEFINITION.transitions,
        { from: 'todo', to: 'done', actors: ['agent'] },
      ],
    };
    const custom = await insertTemplate(definitionWith());
    const invalid = await propose({
      templateId: custom,
      definition: broken,
      reason: 'Drop blocked',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_WORKFLOW');
    const issues = (
      invalid.body as unknown as { details: WorkflowValidationDetails }
    ).details.issues;
    expect(issues.map((issue) => issue.message).join('\n')).toMatch(
      /blocked cannot be removed[\s\S]*Agents may not write done/u,
    );

    const system = await propose({
      templateId: 'default',
      definition: definitionWith([CODE_REVIEW]),
      reason: 'Add review',
    });
    expect(system.status).toBe(409);
    expect(system.body.code).toBe('WORKFLOW_SYSTEM_TEMPLATE');
    expect(
      (await propose({ definition: definitionWith(), reason: 'x' })).body.code,
    ).toBe('INVALID_TARGET');
    expect(
      (
        await propose({
          copyFrom: 'default',
          definition: definitionWith(),
          reason: 'x',
        })
      ).body.code,
    ).toBe('INVALID_NAME');
    expect(
      (
        await propose({
          templateId: custom,
          definition: definitionWith(),
          reason: 'Same',
        })
      ).body.code,
    ).toBe('WORKFLOW_UNCHANGED');
    expect(
      (
        await propose({
          templateId: custom,
          definition: definitionWith([], (status) =>
            status.key === 'in_review'
              ? {
                  ...status,
                  onEnter: [{ type: 'runExecutor', agentId: 'ghost' }],
                }
              : status,
          ),
          reason: 'Ghost reviewer',
        })
      ).body.code,
    ).toBe('INVALID_WORKFLOW');
    expect(await rows(db!, 'workflow_proposals')).toEqual([]);
  });

  it('copies a system template: one pending per run, cards for owner/admins, acceptance creates the template', async () => {
    const definition = definitionWith([CODE_REVIEW], (status) =>
      status.key === 'code_review'
        ? {
            ...status,
            onEnter: [
              { type: 'runExecutor', agentId: world.run.agentId },
              {
                type: 'checklist',
                items: [{ key: 'tests', label: 'Tests pass', required: true }],
              },
            ],
          }
        : status,
    );
    const proposed = await propose({
      copyFrom: 'default',
      name: '软件开发（代码评审）',
      definition,
      reason: 'Add a code review stage.',
    });
    expect(proposed.status).toBe(201);
    const proposal = proposed.body.data;
    expect(proposal).toMatchObject({
      kind: 'copy',
      templateId: null,
      copyFromId: 'default',
      copyFromName: '软件开发',
      name: '软件开发（代码评审）',
      status: 'pending',
      baseRevision: 1,
      affectedProjectCount: 0,
      sourceIssueId: world.issueId,
      proposedByAgentName: 'Scribe',
      canDecide: false,
    });
    expect(proposal.diff.statuses.added.map((status) => status.key)).toEqual([
      'code_review',
    ]);
    expect(proposal.diff.runExecutorAgents).toEqual([
      {
        statusKey: 'code_review',
        agentId: world.run.agentId,
        agentName: 'Scribe',
        isNew: true,
      },
    ]);
    const again = await propose({
      copyFrom: 'default',
      name: 'Other',
      definition,
      reason: 'Again',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('WORKFLOW_PROPOSAL_PENDING');
    // Another run may propose for the same source.
    expect(
      (
        await propose(
          { copyFrom: 'default', name: 'Other', definition, reason: 'Again' },
          await secondRun(),
        )
      ).status,
    ).toBe(201);

    const activity = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'workflow_proposed'",
      [world.issueId],
    );
    expect(activity).toHaveLength(1);
    const cards = await decisionCards(ALICE);
    const card = cards.find(
      (item) => item.payload?.proposalId === proposal.id,
    )!;
    expect(card.payload).toMatchObject({
      kind: 'copy',
      templateName: '软件开发（代码评审）',
      copyFromId: 'default',
      reason: 'Add a code review stage.',
      issueId: world.issueId,
      changes: expect.objectContaining({
        statusesAdded: 1,
        newRunExecutorAgents: 1,
      }),
    });
    expect(
      (card.payload?.actions as InboxAction[]).map((action) => action.key),
    ).toEqual(['accept', 'reject', 'open']);
    expect(await decisionCards(CAROL)).toHaveLength(2);
    expect(await decisionCards(BOB)).toHaveLength(0);

    const member = await world.bob<Data<WorkflowProposal>>(
      'GET',
      `/np/workflows/proposals/${proposal.id}`,
    );
    expect(member.body.data.canDecide).toBe(false);
    expect(
      (await world.bob('POST', `/np/workflows/proposals/${proposal.id}/accept`))
        .status,
    ).toBe(403);
    const accepted = await world.alice<Data<WorkflowProposal>>(
      'POST',
      `/np/workflows/proposals/${proposal.id}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({
      status: 'accepted',
      resultRevision: 1,
      decidedById: ALICE.id,
    });
    const created = accepted.body.data.templateId!;
    const template = await world.alice<Data<WorkflowListItemV5>>(
      'GET',
      `/np/workflows/${created}`,
    );
    expect(template.body.data).toMatchObject({
      name: '软件开发（代码评审）',
      isSystem: false,
      isDefault: false,
      revision: 1,
    });
    expect(template.body.data.definition).toEqual(definition);
    const revisions = await world.bob<Data<WorkflowRevision[]>>(
      'GET',
      `/np/workflows/${created}/revisions`,
    );
    expect(revisions.body.data).toMatchObject([
      {
        revision: 1,
        proposalId: proposal.id,
        note: 'Add a code review stage.',
        createdByType: 'agent',
        createdByName: 'Scribe',
      },
    ]);
    expect(await decisionCards(CAROL)).toHaveLength(1);
    const notices = (
      await world.services.inbox.list(BOB, { kind: 'info' })
    ).data.filter((item) => item.type === ('workflow_decided' as never));
    expect(notices.map((item) => item.payload?.decision)).toEqual(['accepted']);
    expect(
      await rows(
        db!,
        'activities',
        "issue_id = ? AND action = 'workflow_updated'",
        [world.issueId],
      ),
    ).toHaveLength(1);
    const twice = await world.carol(
      'POST',
      `/np/workflows/proposals/${proposal.id}/reject`,
    );
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('WORKFLOW_PROPOSAL_DECIDED');
  });

  it('applies an accepted edit to the projects on the template at once, with snapshots', async () => {
    const custom = await insertTemplate(definitionWith(), 'Team flow');
    const projectId = await projectOn(custom);
    const issue = await world.services.issues.create(ALICE, {
      title: 'Work',
      projectId,
      statusKey: 'in_progress',
    });
    await expect(moveTo(ALICE, issue.id, 'code_review')).rejects.toThrow();
    const proposed = await propose({
      templateId: custom,
      name: 'Team flow v2',
      definition: definitionWith([CODE_REVIEW]),
      reason: 'Review before in_review.',
    });
    expect(proposed.body.data).toMatchObject({
      kind: 'update',
      templateId: custom,
      templateName: 'Team flow',
      currentRevision: 1,
      outdated: false,
      affectedProjectCount: 1,
    });
    expect(proposed.body.data.diff.name).toEqual({
      from: 'Team flow',
      to: 'Team flow v2',
    });
    const accepted = await world.carol<Data<WorkflowProposal>>(
      'POST',
      `/np/workflows/proposals/${proposed.body.data.id}/accept`,
      { comment: 'Go' },
    );
    expect(accepted.body.data).toMatchObject({
      status: 'accepted',
      resultRevision: 2,
      comment: 'Go',
      currentRevision: 2,
    });
    await moveTo(ALICE, issue.id, 'code_review');
    const revisions = await world.alice<Data<WorkflowRevision[]>>(
      'GET',
      `/np/workflows/${custom}/revisions`,
    );
    expect(
      revisions.body.data.map((item) => [
        item.revision,
        item.name,
        item.proposalId,
        item.createdByType,
      ]),
    ).toEqual([
      [2, 'Team flow v2', proposed.body.data.id, 'agent'],
      [1, 'Team flow', null, 'system'],
    ]);
  });
});
