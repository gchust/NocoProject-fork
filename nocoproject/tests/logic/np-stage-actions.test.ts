// @vitest-environment node
/**
 * Workflow stage effects (NP-77 方案 §1–§3), on a real PostgreSQL: runExecutor with a preset agent (and its downgrade
 * to a suggestion when the owner may not invoke it), suggestExecutor, notifyOwner, the checklist snapshot in the claim
 * payload, a failing effect that leaves the transition and the other effects in place, and the loop guard. The seeded
 * templates pass the definition validation. Entry conditions: `np-stage-guards.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ClaimedRunV5 } from '../../server/modules/run/claim.service.ts';
import { validateWorkflowDefinition } from '../../server/modules/workflow/workflow.validate.ts';
import {
  ALICE,
  BOB,
  CAROL,
  claimOne,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  rows,
  runRows,
  triggerRows,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  activities,
  current,
  definitionWith,
  inbox,
  issueIn,
  move,
  projectWith,
  setupWorld,
  triggerTypes,
  world,
} from './np-stage-harness.ts';

const opened = await openNpTestDatabase('np_t_stage_actions');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-stage-actions] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  if (db) await setupWorld(db);
});

describe.skipIf(!db)('seeded templates', () => {
  it('pass the definition validation unchanged', async () => {
    const templates = await rows(db!, 'workflow_templates');
    expect(templates.map((row) => row.id).sort()).toEqual(
      expect.arrayContaining(['default', 'software-with-approval']),
    );
    for (const row of templates) {
      const definition =
        typeof row.definition === 'string'
          ? JSON.parse(row.definition)
          : row.definition;
      expect(await validateWorkflowDefinition(definition)).toMatchObject({
        ok: true,
      });
    }
  });
});

describe.skipIf(!db)('stage effects', () => {
  it('runExecutor with a preset agent sets the executor and enqueues a stageEntered run with the rendered instruction', async () => {
    const projectId = await projectWith(
      definitionWith({
        in_review: [
          {
            type: 'checklist',
            items: [{ key: 'review', label: 'Code reviewed', required: true }],
          },
          {
            type: 'runExecutor',
            agentId: world.reviewer,
            instruction:
              'Review {{issue.identifier}} ({{ from }} → {{to}}) for {{owner.name}}. {{unknown}}',
          },
        ],
      }),
    );
    const issue = await issueIn(projectId, 'in_progress');
    const result = await move(CAROL, issue.id, 'in_review');
    expect(result.issue.statusKey).toBe('in_review');

    const after = await current(issue.id);
    expect(result.issue.revision).toBe(after.revision);
    expect(after).toMatchObject({
      executorType: 'agent',
      executorId: world.reviewer,
    });
    const [run] = await runRows(db!, `subject_id = '${issue.id}'`);
    expect(run).toMatchObject({
      agent_id: world.reviewer,
      actor_user_id: ALICE.id,
    });
    const [trigger] = await triggerRows(db!, run!.id as string);
    expect(trigger?.type).toBe('stageEntered');
    const payload =
      typeof trigger?.payload === 'string'
        ? JSON.parse(trigger.payload)
        : trigger?.payload;
    expect(payload).toEqual({
      from: 'in_progress',
      to: 'in_review',
      instruction: `Review ${issue.identifier} (in_progress → in_review) for Alice. {{unknown}}`,
    });
    const [applied] = (
      await activities(issue.id, 'stage_action_applied')
    ).filter((item) => item.details.action === 'runExecutor');
    expect(applied?.details).toMatchObject({
      statusKey: 'in_review',
      agentId: world.reviewer,
      runId: run!.id,
    });
    const [changed] = await activities(issue.id, 'executor_changed');
    expect(changed?.details).toMatchObject({ trigger: 'stageEntered' });

    // The brief: the stage instruction on the trigger, the current checklist on the issue.
    const claimed = (await claimOne(
      world.services,
      ALICE,
      world.fixture,
    )) as unknown as ClaimedRunV5 | undefined;
    expect(claimed?.triggers[0]).toMatchObject({
      type: 'stageEntered',
      stage: { from: 'in_progress', to: 'in_review' },
    });
    expect(claimed?.triggers[0]?.stage?.instruction).toContain('Review');
    expect(claimed?.issue.checklist).toMatchObject({
      statusKey: 'in_review',
      current: true,
      complete: false,
      items: [{ itemKey: 'review', label: 'Code reviewed', checked: false }],
    });
  });

  it('runExecutor falls back to a workflow suggestion when the owner may not invoke the preset agent', async () => {
    const bobRuntime = await registerRuntime(world.services, BOB, 'daemon-bob');
    const bobBot = await createAgent(
      world.services,
      BOB,
      bobRuntime.runtimeId,
      'BobBot',
    );
    const projectId = await projectWith(
      definitionWith({ in_review: [{ type: 'runExecutor', agentId: bobBot }] }),
    );
    const issue = await issueIn(projectId, 'in_progress');
    await move(CAROL, issue.id, 'in_review');

    expect(await runRows(db!, `subject_id = '${issue.id}'`)).toEqual([]);
    expect((await current(issue.id)).executorId).toBeNull();
    const [skipped] = await activities(issue.id, 'stage_action_skipped');
    expect(skipped?.details).toMatchObject({
      action: 'runExecutor',
      reason: 'ownerCannotInvoke',
      downgradedTo: 'suggestExecutor',
    });
    const [proposal] = await rows(db!, 'executor_proposals', 'issue_id = ?', [
      issue.id,
    ]);
    expect(proposal).toMatchObject({
      proposed_agent_id: bobBot,
      proposed_by_agent_id: null,
      source: 'workflow',
      stage_status_key: 'in_review',
      status: 'pending',
    });
    expect(skipped?.details.proposalId).toBe(proposal!.id);
    expect(await inbox(ALICE.id!, 'proposal_pending', issue.id)).toHaveLength(
      1,
    );
    expect(
      await inbox(ALICE.id!, 'stage_action_problem', issue.id),
    ).toHaveLength(1);
  });

  it('suggestExecutor leaves a workflow proposal the owner accepts, and leaving the status supersedes it', async () => {
    const projectId = await projectWith(
      definitionWith({
        in_review: [
          {
            type: 'suggestExecutor',
            agentId: world.reviewer,
            reason: 'Reviews',
          },
        ],
      }),
    );
    const issue = await issueIn(projectId, 'in_progress');
    await move(CAROL, issue.id, 'in_review');
    const [first] = (await world.services.issueQueries.detail(ALICE, issue.id))
      .proposals;
    expect(first).toMatchObject({
      proposedAgentId: world.reviewer,
      proposedByAgentId: null,
      proposedByAgentName: null,
      source: 'workflow',
      stageStatusKey: 'in_review',
      status: 'pending',
    });
    const [card] = await inbox(ALICE.id!, 'proposal_pending', issue.id);
    expect(card?.resolved_at).toBeNull();
    expect(card?.actor_type).toBe('system');

    // Leaving in_review supersedes it and resolves the card.
    await move(CAROL, issue.id, 'in_progress');
    const [superseded] = (
      await world.services.issueQueries.detail(ALICE, issue.id)
    ).proposals;
    expect(superseded?.status).toBe('superseded');
    expect(
      (await inbox(ALICE.id!, 'proposal_pending', issue.id))[0]?.resolved_at,
    ).not.toBeNull();

    // Entering again suggests again, once; the owner accepts it.
    await move(CAROL, issue.id, 'in_review');
    const pending = (
      await world.services.issueQueries.detail(ALICE, issue.id)
    ).proposals.filter((item) => item.status === 'pending');
    expect(pending).toHaveLength(1);
    const accepted = await world.services.proposals.accept(
      ALICE,
      issue.id,
      pending[0]!.id,
      {},
    );
    expect(accepted.status).toBe('accepted');
    expect(await current(issue.id)).toMatchObject({
      executorType: 'agent',
      executorId: world.reviewer,
    });
    expect(await triggerTypes(issue.id)).toEqual(['proposalAccepted']);
  });

  it('notifyOwner puts a stage_entered notice in the owner inbox', async () => {
    const projectId = await projectWith(
      definitionWith({
        in_review: [{ type: 'notifyOwner', message: 'Ready for review' }],
      }),
    );
    const issue = await issueIn(projectId, 'in_progress');
    await move(CAROL, issue.id, 'in_review');
    const [notice] = await inbox(ALICE.id!, 'stage_entered', issue.id);
    expect(notice).toMatchObject({ kind: 'info', body: 'Ready for review' });
    expect(JSON.parse(String(notice?.payload))).toMatchObject({
      from: 'in_progress',
      to: 'in_review',
      message: 'Ready for review',
    });
    // The owner's own move notifies nobody.
    await move(ALICE, issue.id, 'in_progress');
    await move(ALICE, issue.id, 'in_review');
    expect(await inbox(ALICE.id!, 'stage_entered', issue.id)).toHaveLength(1);
  });

  it('a failing effect is recorded and the transition and the other effects still apply', async () => {
    const projectId = await projectWith(
      definitionWith({
        in_review: [
          // 80 characters: longer than issueChecklistItems.itemKey, so the insert fails inside its savepoint.
          {
            type: 'checklist',
            items: [{ key: 'k'.repeat(80), label: 'Too long', required: true }],
          },
          { type: 'notifyOwner' },
        ],
      }),
    );
    const issue = await issueIn(projectId, 'in_progress');
    const result = await move(CAROL, issue.id, 'in_review');
    expect(result.issue.statusKey).toBe('in_review');
    expect((await current(issue.id)).statusKey).toBe('in_review');
    const [failed] = await activities(issue.id, 'stage_action_failed');
    expect(failed?.details).toMatchObject({
      action: 'checklist',
      statusKey: 'in_review',
    });
    expect(String(failed?.details.error)).toMatch(/too long/u);
    expect(await rows(db!, 'issue_checklist_items')).toEqual([]);
    const applied = await activities(issue.id, 'stage_action_applied');
    expect(applied.map((item) => item.details.action)).toEqual(['notifyOwner']);
    expect(await inbox(ALICE.id!, 'stage_entered', issue.id)).toHaveLength(1);
    expect(
      await inbox(ALICE.id!, 'stage_action_problem', issue.id),
    ).toHaveLength(1);
    // The next write still works: the transaction was not aborted.
    expect((await move(CAROL, issue.id, 'in_progress')).issue.statusKey).toBe(
      'in_progress',
    );
  });

  it('the loop guard suppresses runExecutor beyond the limit within the window', async () => {
    await world.services.settings.write(world.services.tx.read(), {
      stageRunLimit: 2,
    });
    const projectId = await projectWith(
      definitionWith({
        in_review: [{ type: 'runExecutor', agentId: world.reviewer }],
      }),
    );
    const issue = await issueIn(projectId, 'in_progress');
    for (let round = 0; round < 3; round += 1) {
      await move(CAROL, issue.id, 'in_review');
      await move(CAROL, issue.id, 'in_progress');
    }
    const applied = (await activities(issue.id, 'stage_action_applied')).filter(
      (item) => item.details.action === 'runExecutor',
    );
    expect(applied).toHaveLength(2);
    const [suppressed] = await activities(issue.id, 'stage_action_suppressed');
    expect(suppressed?.details).toMatchObject({
      action: 'runExecutor',
      limit: 2,
      windowHours: 24,
    });
    expect(
      await inbox(ALICE.id!, 'stage_action_problem', issue.id),
    ).toHaveLength(1);
  });
});
