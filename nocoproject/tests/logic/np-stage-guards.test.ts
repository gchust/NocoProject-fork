// @vitest-environment node
/**
 * Workflow entry conditions (NP-77 方案 §1, §2), on a real PostgreSQL: requirePrMerged for human, agent and system
 * writes; a required checklist item of the status being left (agent and browser checklist endpoints, cancelling never
 * blocked, run tokens limited to their own issue); an approval whose conditions no longer hold becomes stale.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  ApprovalRequest,
  IssueChecklist,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  CAROL,
  openNpTestDatabase,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  activities,
  claimedDevIssue,
  current,
  definitionWith,
  inbox,
  issueIn,
  linkPullRequest,
  move,
  projectWith,
  setupWorld,
  world,
} from './np-stage-harness.ts';

const opened = await openNpTestDatabase('np_t_stage_guards');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-stage-guards] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  if (db) await setupWorld(db);
});

describe.skipIf(!db)('entry conditions', () => {
  it('requirePrMerged refuses human and agent writes until a linked PR is merged; the system write passes', async () => {
    const projectId = await projectWith(
      definitionWith({ in_review: [{ type: 'requirePrMerged' }] }),
    );
    const { issue, call } = await claimedDevIssue(projectId);
    expect(
      (
        await call('POST', `/issues/${issue.id}/status`, {
          statusKey: 'in_progress',
        })
      ).status,
    ).toBe(200);
    const agentTry = await call('POST', `/issues/${issue.id}/status`, {
      statusKey: 'in_review',
    });
    expect(agentTry).toMatchObject({
      status: 409,
      body: { code: 'STAGE_PR_NOT_MERGED' },
    });
    await expect(move(CAROL, issue.id, 'in_review')).rejects.toMatchObject({
      code: 'STAGE_PR_NOT_MERGED',
    });
    await linkPullRequest(issue.id, 'open');
    await expect(move(CAROL, issue.id, 'in_review')).rejects.toMatchObject({
      code: 'STAGE_PR_NOT_MERGED',
    });
    expect((await current(issue.id)).statusKey).toBe('in_progress');
    await linkPullRequest(issue.id, 'merged');
    expect(
      (
        await call('POST', `/issues/${issue.id}/status`, {
          statusKey: 'in_review',
        })
      ).status,
    ).toBe(200);

    // The merge flow's system write is not held up.
    const other = await issueIn(projectId, 'in_progress');
    const moved = await world.services.tx.run((tx) =>
      world.services.issues.systemSetStatus(tx, other.id, 'in_review', {
        reason: 'prMerged',
      }),
    );
    expect(moved?.statusKey).toBe('in_review');
  });

  it('a required checklist item blocks leaving the status until checked; cancelling is never blocked', async () => {
    const projectId = await projectWith(
      definitionWith({
        in_progress: [
          {
            type: 'checklist',
            items: [
              { key: 'tests', label: 'Tests pass', required: true },
              { key: 'docs', label: 'Docs updated', required: false },
            ],
          },
        ],
      }),
    );
    const { issue, call } = await claimedDevIssue(projectId);
    await call('POST', `/issues/${issue.id}/status`, {
      statusKey: 'in_progress',
    });
    const refused = await call('POST', `/issues/${issue.id}/status`, {
      statusKey: 'in_review',
    });
    expect(refused).toMatchObject({
      status: 409,
      body: { code: 'CHECKLIST_INCOMPLETE' },
    });
    await expect(move(CAROL, issue.id, 'in_review')).rejects.toMatchObject({
      code: 'CHECKLIST_INCOMPLETE',
    });

    const listed = await call('GET', `/issues/${issue.id}/checklists`);
    expect(listed.status).toBe(200);
    expect((listed.body.data as IssueChecklist[])[0]).toMatchObject({
      statusKey: 'in_progress',
      current: true,
      complete: false,
    });
    expect(
      (
        await call(
          'PATCH',
          `/issues/${issue.id}/checklists/in_progress/items/tests`,
          {
            checked: 'yes',
          },
        )
      ).status,
    ).toBe(400);
    const checked = await call(
      'PATCH',
      `/issues/${issue.id}/checklists/in_progress/items/tests`,
      { checked: true },
    );
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({
      complete: true,
      items: [
        {
          itemKey: 'tests',
          checked: true,
          checkedByType: 'agent',
          checkedById: world.dev,
          checkedByName: 'Dev',
        },
        { itemKey: 'docs', checked: false },
      ],
    });
    const [activity] = await activities(issue.id, 'checklist_item_checked');
    expect(activity?.details).toMatchObject({
      statusKey: 'in_progress',
      itemKey: 'tests',
    });
    expect(
      (
        await call('POST', `/issues/${issue.id}/status`, {
          statusKey: 'in_review',
        })
      ).status,
    ).toBe(200);

    // Another issue: the browser endpoints, and cancelling with the item unchecked.
    const other = await issueIn(projectId, 'todo');
    await move(ALICE, other.id, 'in_progress');
    expect(
      (await world.services.checklists.list(CAROL, other.id))[0]?.items,
    ).toHaveLength(2);
    await expect(
      world.services.checklists.set(CAROL, other.id, 'in_progress', 'nope', {
        checked: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await move(ALICE, other.id, 'cancelled')).issue.statusKey).toBe(
      'cancelled',
    );
  });

  it('a run token may only check items of its own issue', async () => {
    const projectId = await projectWith(
      definitionWith({
        in_progress: [
          {
            type: 'checklist',
            items: [{ key: 'tests', label: 'Tests pass', required: true }],
          },
        ],
      }),
    );
    const { call } = await claimedDevIssue(projectId);
    const other = await issueIn(projectId, 'todo');
    await move(ALICE, other.id, 'in_progress');
    const response = await call(
      'PATCH',
      `/issues/${other.id}/checklists/in_progress/items/tests`,
      { checked: true },
    );
    expect(response).toMatchObject({
      status: 403,
      body: { code: 'ISSUE_NOT_IN_RUN' },
    });
    expect((await call('GET', `/issues/${other.id}/checklists`)).status).toBe(
      200,
    );
  });

  it('an approval whose entry conditions no longer hold is cancelled as stale and the approvers are told', async () => {
    const projectId = await projectWith(
      definitionWith(
        {
          in_review: [
            {
              type: 'checklist',
              items: [{ key: 'qa', label: 'QA signed off', required: true }],
            },
          ],
        },
        [
          {
            from: 'in_review',
            to: 'done',
            actors: ['user'],
            approval: { approvers: ['owner'] },
          },
        ],
      ),
    );
    const issue = await issueIn(projectId, 'in_progress');
    await move(CAROL, issue.id, 'in_review');
    await world.services.checklists.set(CAROL, issue.id, 'in_review', 'qa', {
      checked: true,
    });
    const held = await move(CAROL, issue.id, 'done');
    const request = held.pendingApproval as ApprovalRequest;
    expect(request.status).toBe('pending');
    await world.services.checklists.set(CAROL, issue.id, 'in_review', 'qa', {
      checked: false,
    });

    const decided = await world.services.approvals.approve(
      request.id,
      ALICE,
      'ok',
    );
    expect(decided.status).toBe('cancelled');
    expect((await current(issue.id)).statusKey).toBe('in_review');
    const [stale] = await activities(issue.id, 'approval_stale');
    expect(stale?.details).toMatchObject({
      requestId: request.id,
      code: 'CHECKLIST_INCOMPLETE',
    });
    expect(await inbox(CAROL.id!, 'approval_stale', issue.id)).toHaveLength(1);
    expect(
      (await inbox(ALICE.id!, 'approval_pending', issue.id))[0]?.resolved_at,
    ).not.toBeNull();

    // With the item checked again, a new request goes through.
    await world.services.checklists.set(CAROL, issue.id, 'in_review', 'qa', {
      checked: true,
    });
    const again = await move(CAROL, issue.id, 'done');
    await world.services.approvals.approve(again.pendingApproval!.id, ALICE);
    expect((await current(issue.id)).statusKey).toBe('done');
  });
});
