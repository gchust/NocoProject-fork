// @vitest-environment node
/**
 * The approval gate (iteration-2 contract §D), on a real PostgreSQL.
 *
 * "Replace the checklist" (design proposal §8): the shared cases run twice — against `DbApprovalGateway` (today's temporary implementation)
 * and against an in-memory double of a future official gateway — to show the business code only needs the
 * `ApprovalGateway` interface. Activities, inbox cards and the workflow switch are checked against the database
 * gateway only.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import type {
  ApprovalRequest,
  IssueV2,
  StatusChangePendingResponse,
} from '../../server/modules/shared/protocol.ts';
import { createMemoryApprovalGateway } from './np-approval-memory.ts';
import {
  ALICE,
  BOB,
  CAROL,
  agentApi,
  buildServices,
  claimOne,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
  type NpTestOptions,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_approval');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-approval] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

const STATUSES = [
  ['backlog', 'unstarted'],
  ['todo', 'unstarted'],
  ['in_progress', 'started'],
  ['in_review', 'started'],
  ['blocked', 'started'],
  ['done', 'done'],
  ['cancelled', 'closed'],
].map(([key, category]) => ({
  key,
  name: key,
  category,
  color: 'gray',
  builtIn: true,
}));

/** Lead-only acceptance, and an agent delivery that the owner must approve. */
const LEAD_ONLY = {
  statuses: STATUSES,
  transitions: [
    { from: '*', to: '*', actors: ['user'] },
    {
      from: 'in_review',
      to: 'done',
      actors: ['user'],
      approval: { approvers: ['projectLead'] },
    },
    { from: 'todo', to: 'in_progress', actors: ['agent'] },
    {
      from: 'in_progress',
      to: 'in_review',
      actors: ['agent'],
      approval: { approvers: ['owner'] },
    },
    { from: 'in_progress', to: 'todo', actors: ['system'] },
    { from: '*', to: 'done', actors: ['system'] },
  ],
  childBatchDoneWakesParentExecutor: true,
};

async function insertTemplate(): Promise<void> {
  await db!.knex.raw(
    `INSERT INTO "${db!.schema}".workflow_templates (id, name, is_default, definition, created_at, updated_at)
     VALUES ('lead-only', 'Lead only', false, ?, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(LEAD_ONLY)],
  );
}

let services: NpServices;

async function setup(options: NpTestOptions = {}) {
  await resetData(db!);
  services = buildServices(db!.database, options).services;
  await setRole(db!, ALICE, 'owner');
  await setRole(db!, BOB, 'member');
  await setRole(db!, CAROL, 'member');
  await insertTemplate();
}

async function projectWith(workflowId: string, leadUserId: string | null) {
  const project = await services.projects.create(ALICE, {
    name: `P ${workflowId}`,
    leadUserId: BOB.id,
  });
  await services.projects.update(ALICE, project.id, { workflowId, leadUserId });
  return project.id;
}

async function issueIn(
  projectId: string,
  statusKey = 'in_review',
): Promise<IssueV2> {
  return services.issues.create(ALICE, {
    title: 'Ship it',
    projectId,
    statusKey,
  });
}

async function move(actor: Actor, issue: IssueV2, statusKey: string) {
  const fresh = (await services.issueQueries.detail(ALICE, issue.id)).issue;
  return services.issues.patch(actor, issue.id, {
    statusKey,
    revision: fresh.revision,
  });
}

const GATEWAYS: [string, NpTestOptions][] = [
  ['DbApprovalGateway', {}],
  [
    'MemoryApprovalGateway',
    { approvalGateway: (context) => createMemoryApprovalGateway(context) },
  ],
];

describe.skipIf(!db).each(GATEWAYS)(
  'approval gate contract: %s',
  (_name, options) => {
    beforeEach(async () => setup(options));

    it('passes transitions without approval and the approver acting on their own', async () => {
      const projectId = await projectWith('software-with-approval', BOB.id);
      const issue = await issueIn(projectId, 'in_progress');
      const plain = await move(CAROL, issue, 'in_review');
      expect(plain.pendingApproval).toBeNull();
      expect(plain.issue.statusKey).toBe('in_review');
      const self = await move(ALICE, issue, 'done');
      expect(self.pendingApproval).toBeNull();
      expect(self.issue.statusKey).toBe('done');
    });

    it("holds a member's change for approval, refuses a second request and lists it for approvers", async () => {
      const projectId = await projectWith('software-with-approval', BOB.id);
      const issue = await issueIn(projectId);
      const held = await move(CAROL, issue, 'done');
      expect(held.issue.statusKey).toBe('in_review');
      const request = held.pendingApproval as ApprovalRequest;
      expect(request).toMatchObject({
        status: 'pending',
        fromStatus: 'in_review',
        toStatus: 'done',
        requestedByType: 'user',
        requestedById: CAROL.id,
      });
      expect([...request.approverUserIds].sort()).toEqual(
        [ALICE.id, BOB.id].sort(),
      );
      expect(
        (await services.issueQueries.detail(ALICE, issue.id)).issue.statusKey,
      ).toBe('in_review');
      await expect(move(CAROL, issue, 'done')).rejects.toMatchObject({
        code: 'APPROVAL_PENDING',
      });
      expect(
        (await services.approvals.listPending(BOB.id!)).map((item) => item.id),
      ).toEqual([request.id]);
      expect(await services.approvals.listPending(CAROL.id!)).toEqual([]);
      expect(
        (await services.approvals.listForIssue(issue.id)).map(
          (item) => item.id,
        ),
      ).toContain(request.id);
    });

    it("applies the transition on approval, on the approver's behalf", async () => {
      const projectId = await projectWith('software-with-approval', BOB.id);
      const issue = await issueIn(projectId);
      const { pendingApproval } = await move(CAROL, issue, 'done');
      await expect(
        services.approvals.approve(pendingApproval!.id, CAROL),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      const approved = await services.approvals.approve(
        pendingApproval!.id,
        BOB,
        'ok',
      );
      expect(approved).toMatchObject({
        status: 'approved',
        decidedById: BOB.id,
      });
      const detail = await services.issueQueries.detail(ALICE, issue.id);
      expect(detail.issue.statusKey).toBe('done');
      const change = detail.activities
        .filter((item) => item.action === 'status_changed')
        .at(-1);
      expect(change).toMatchObject({ actorType: 'user', actorId: BOB.id });
      expect(change?.details).toMatchObject({
        from: 'in_review',
        to: 'done',
        approvalRequestId: approved.id,
      });
      await expect(
        services.approvals.reject(approved.id, BOB),
      ).rejects.toMatchObject({
        code: 'APPROVAL_DECIDED',
      });
    });

    it('leaves the status on rejection', async () => {
      const projectId = await projectWith('software-with-approval', BOB.id);
      const issue = await issueIn(projectId);
      const { pendingApproval } = await move(CAROL, issue, 'done');
      const rejected = await services.approvals.reject(
        pendingApproval!.id,
        ALICE,
        'not yet',
      );
      expect(rejected).toMatchObject({
        status: 'rejected',
        comment: 'not yet',
      });
      expect(
        (await services.issueQueries.detail(ALICE, issue.id)).issue.statusKey,
      ).toBe('in_review');
      const again = await move(CAROL, issue, 'done');
      expect(again.pendingApproval?.status).toBe('pending');
    });

    it('passes when the approvers resolve to nobody', async () => {
      const projectId = await projectWith('lead-only', null);
      const issue = await issueIn(projectId);
      const result = await move(CAROL, issue, 'done');
      expect(result.pendingApproval).toBeNull();
      expect(result.issue.statusKey).toBe('done');
    });

    it('cancels a pending request when the status moves by another path', async () => {
      const projectId = await projectWith('software-with-approval', BOB.id);
      const issue = await issueIn(projectId);
      const { pendingApproval } = await move(CAROL, issue, 'done');
      await move(ALICE, issue, 'in_progress');
      const [request] = (
        await services.approvals.listForIssue(issue.id)
      ).filter((item) => item.id === pendingApproval!.id);
      expect(request?.status).toBe('cancelled');
      await expect(
        services.approvals.approve(pendingApproval!.id, BOB),
      ).rejects.toMatchObject({
        code: 'APPROVAL_DECIDED',
      });
    });

    it('answers 202 on the agent status route and applies after the owner approves', async () => {
      const fixture = await registerRuntime(services, ALICE);
      const agentId = await createAgent(
        services,
        ALICE,
        fixture.runtimeId,
        'Dev',
      );
      const projectId = await projectWith('lead-only', BOB.id);
      const issue = await services.issues.create(ALICE, {
        title: 'Agent work',
        projectId,
        executor: { type: 'agent', id: agentId },
      });
      const claimed = await claimOne(services, ALICE, fixture);
      const call = agentApi(services, claimed!.token);
      expect(
        (
          await call('POST', `/issues/${issue.id}/status`, {
            statusKey: 'in_progress',
          })
        ).status,
      ).toBe(200);
      const held = await call('POST', `/issues/${issue.id}/status`, {
        statusKey: 'in_review',
      });
      expect(held.status).toBe(202);
      const data = held.body.data as StatusChangePendingResponse;
      expect(data.issue.statusKey).toBe('in_progress');
      expect(data.pendingApproval).toMatchObject({
        requestedByType: 'agent',
        requestedById: agentId,
      });
      expect(data.pendingApproval.approverUserIds).toEqual([ALICE.id]);
      await services.approvals.approve(data.pendingApproval.id, ALICE);
      expect(
        (await services.issueQueries.detail(ALICE, issue.id)).issue.statusKey,
      ).toBe('in_review');
    });
  },
);

describe.skipIf(!db)(
  'approval activities, inbox and workflow switch (database gateway)',
  () => {
    beforeEach(async () => setup());

    async function actions(issueId: string): Promise<string[]> {
      return (
        await rows(db!, 'activities', 'issue_id = ? ORDER BY created_at, id', [
          issueId,
        ])
      ).map((row) => row.action as string);
    }

    it('records the approval activities', async () => {
      const projectId = await projectWith('software-with-approval', BOB.id);
      const selfIssue = await issueIn(projectId);
      await move(ALICE, selfIssue, 'done');
      expect(await actions(selfIssue.id)).toContain('approval_self');

      const issue = await issueIn(projectId);
      const { pendingApproval } = await move(CAROL, issue, 'done');
      await services.approvals.reject(pendingApproval!.id, BOB, 'later');
      const again = await move(CAROL, issue, 'done');
      await services.approvals.approve(again.pendingApproval!.id, BOB);
      expect(await actions(issue.id)).toEqual(
        expect.arrayContaining([
          'approval_requested',
          'approval_rejected',
          'approval_approved',
        ]),
      );

      const noLead = await projectWith('lead-only', null);
      const orphan = await issueIn(noLead);
      await move(CAROL, orphan, 'done');
      expect(await actions(orphan.id)).toContain('approval_no_approver');
    });

    it('asks every approver, resolves their cards on decision and tells the requester', async () => {
      const projectId = await projectWith('software-with-approval', BOB.id);
      const issue = await issueIn(projectId);
      const { pendingApproval } = await move(CAROL, issue, 'done');
      const cards = await rows(
        db!,
        'inbox_items',
        "type = 'approval_pending' AND resolved_at IS NULL",
      );
      expect(cards.map((row) => row.user_id).sort()).toEqual(
        [ALICE.id, BOB.id].sort(),
      );
      expect(cards.map((row) => row.kind)).toEqual(['decision', 'decision']);
      expect(cards[0]?.dedupe_key).toMatch(
        /^user:u-(alice|bob):approval_pending:/u,
      );
      await services.approvals.approve(pendingApproval!.id, BOB);
      expect(
        await rows(
          db!,
          'inbox_items',
          "type = 'approval_pending' AND resolved_at IS NULL",
        ),
      ).toEqual([]);
      const decided = await rows(
        db!,
        'inbox_items',
        "type = 'approval_decided'",
      );
      expect(decided.map((row) => row.user_id)).toEqual([CAROL.id]);
      expect(JSON.parse(decided[0]?.payload as string)).toMatchObject({
        decision: 'approved',
        toStatus: 'done',
        identifier: issue.identifier,
      });
      const detail = await services.issueQueries.detail(ALICE, issue.id);
      expect(detail.approvals.map((item) => item.status)).toEqual(['approved']);
    });

    it('refuses a workflow switch while issues sit in a status the new template lacks', async () => {
      const custom = {
        ...LEAD_ONLY,
        statuses: STATUSES.filter((status) => status.key !== 'in_review'),
        transitions: [{ from: '*', to: '*', actors: ['user'] }],
      };
      await db!.knex.raw(
        `INSERT INTO "${db!.schema}".workflow_templates (id, name, is_default, definition, created_at, updated_at)
       VALUES ('no-review', 'No review', false, ?, now(), now())`,
        [JSON.stringify(custom)],
      );
      const projectId = await projectWith('software-with-approval', BOB.id);
      const issue = await issueIn(projectId);
      await expect(
        services.projects.update(ALICE, projectId, { workflowId: 'no-review' }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_STATUS_CONFLICT' });
      await move(ALICE, issue, 'todo');
      const project = await services.projects.update(ALICE, projectId, {
        workflowId: 'no-review',
      });
      expect(project.workflowId).toBe('no-review');
    });
  },
);
