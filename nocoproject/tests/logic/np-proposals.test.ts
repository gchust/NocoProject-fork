// @vitest-environment node
/**
 * Agent sub-issue creation through a real run token and the agent API router, executor proposals and delegation
 * (contract §D, §H), on a real PostgreSQL.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createAgentApiRoutes,
  runTokenAuth,
} from '../../server/modules/run/agent-api.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import { guarded } from '../../server/modules/shared/http.ts';
import type { AgentCreateIssueResponse } from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  runRows,
  triggerRows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_proposals');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-proposals] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let runtimeId: string;
let daemonId: string;
let lead: string;
let helper: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  ({ runtimeId, daemonId } = await registerRuntime(services, ALICE));
  lead = await createAgent(services, ALICE, runtimeId, 'Lead');
  helper = await createAgent(services, ALICE, runtimeId, 'Helper');
});

/** A parent issue executed by Lead, claimed: returns the agent API router and the run token. */
async function claimParent(autoExecuteSubtasks: boolean) {
  const parent = await services.issues.create(ALICE, {
    title: 'Parent',
    autoExecuteSubtasks,
    executor: { type: 'agent', id: lead },
  });
  const claim = await services.claims.claim(
    ALICE.id!,
    { daemonId, slots: [{ runtimeId, free: 1 }] },
    'http://test',
  );
  const claimed = claim.runs[0]!;
  const router = guarded(
    [runTokenAuth(services.runTokens)],
    createAgentApiRoutes({
      issues: services.issues,
      queries: services.issueQueries,
      comments: services.comments,
      agentIssues: services.agentIssues,
      pullRequests: services.pullRequests,
    }),
  );
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await router.request(path, {
      method,
      headers: {
        authorization: `Bearer ${claimed.token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as { data: unknown; code?: string },
    };
  };
  return { parent, claimed, call };
}

async function triggerTypes(issueId: string): Promise<string[]> {
  const types: string[] = [];
  for (const run of await runRows(db!, `subject_id = '${issueId}'`))
    for (const trigger of await triggerRows(db!, run.id as string))
      types.push(trigger.type as string);
  return types;
}

describe.skipIf(!db)('agent sub-issues and proposals (PostgreSQL)', () => {
  it('creates a sub-issue with the parent owner, stage, labels and blockers, via the run token', async () => {
    const { parent, claimed, call } = await claimParent(false);
    expect(claimed.issue).toMatchObject({
      parent: null,
      stage: null,
      autoExecuteSubtasks: false,
      projectId: null,
    });
    expect(claimed.agent.delegationTargets).toEqual([]);
    expect(claimed.project).toBeNull();

    const first = await call('POST', '/issues', { title: 'Design', stage: 1 });
    expect(first.status).toBe(201);
    const design = (first.body.data as AgentCreateIssueResponse).issue;
    const second = await call('POST', '/issues', {
      title: 'Build',
      stage: 2,
      blockedBy: [design.identifier],
      labels: ['backend', 'backend'],
      priority: 'high',
    });
    const created = second.body.data as AgentCreateIssueResponse;
    expect(created.issue).toMatchObject({
      parentIssueId: parent.id,
      ownerUserId: ALICE.id,
      ownerName: 'Alice',
      stage: 2,
      priority: 'high',
      labels: ['backend'],
      executorType: 'none',
      createdById: null,
    });
    expect(created.issue.blockers.map((item) => item.reason).sort()).toEqual([
      'dependency',
      'stage',
    ]);
    expect(created.proposal).toBeNull();

    const children = await call('GET', `/issues/${parent.identifier}/children`);
    expect(children.body.data).toEqual([
      expect.objectContaining({ title: 'Design', stage: 1, blockedCount: 0 }),
      expect.objectContaining({ title: 'Build', stage: 2, blockedCount: 2 }),
    ]);
    const context = await call('GET', '/context');
    expect(context.body.data).toMatchObject({ project: null });

    // The CLI removes a dependency by the blocking issue id.
    const removed = await call(
      'DELETE',
      `/issues/${created.issue.identifier}/dependencies?dependsOnIssueId=${design.id}&type=blockedBy`,
    );
    expect(removed.status).toBe(200);
    const readded = await call(
      'POST',
      `/issues/${created.issue.id}/dependencies`,
      {
        dependsOnIssueId: design.id,
        type: 'blockedBy',
      },
    );
    expect(readded.status).toBe(201);

    // Writes outside the run's tree are refused.
    const other = await services.issues.create(ALICE, { title: 'Elsewhere' });
    const outside = await call('POST', '/issues', {
      title: 'Nope',
      parentIssueId: other.id,
    });
    expect(outside.status).toBe(403);
    expect(outside.body.code).toBe('ISSUE_NOT_IN_RUN');
  });

  it("executor 'self' runs it when the parent allows, otherwise proposes", async () => {
    const auto = await claimParent(true);
    const selfRun = await auto.call('POST', '/issues', {
      title: 'Mine',
      executor: 'self',
    });
    const mine = selfRun.body.data as AgentCreateIssueResponse;
    expect(mine.issue.executor).toMatchObject({ type: 'agent', id: lead });
    expect(mine.proposal).toBeNull();
    expect(mine.triggered).toHaveLength(1);
    expect(await triggerTypes(mine.issue.id)).toEqual(['assign']);
    const [run] = await runRows(db!, `subject_id = '${mine.issue.id}'`);
    expect(run!.actor_user_id).toBe(ALICE.id);

    await resetData(db!);
    services = buildServices(db!.database).services;
    ({ runtimeId, daemonId } = await registerRuntime(services, ALICE));
    lead = await createAgent(services, ALICE, runtimeId, 'Lead');
    const manual = await claimParent(false);
    const proposed = (
      await manual.call('POST', '/issues', { title: 'Maybe', executor: 'self' })
    ).body.data as AgentCreateIssueResponse;
    expect(proposed.issue.executor.type).toBe('none');
    expect(proposed.issue.suggestedExecutorAgentId).toBe(lead);
    expect(proposed.proposal).toMatchObject({
      status: 'pending',
      proposedAgentId: lead,
      proposedByAgentId: lead,
      proposedAgentName: 'Lead',
    });
    expect(
      await runRows(db!, `subject_id = '${proposed.issue.id}'`),
    ).toHaveLength(0);
  });

  it('auto-accepts a delegated agent and proposes an undelegated one, merging the owner card', async () => {
    const { parent, call } = await claimParent(false);
    const pending1 = (
      await call('POST', '/issues', { title: 'P1', executor: helper })
    ).body.data as AgentCreateIssueResponse;
    const pending2 = (
      await call('POST', '/issues', { title: 'P2', executor: helper })
    ).body.data as AgentCreateIssueResponse;
    expect(pending1.proposal?.status).toBe('pending');
    const cards = await rows(db!, 'inbox_items', "type = 'proposal_pending'");
    expect(cards).toEqual([
      expect.objectContaining({
        user_id: ALICE.id,
        issue_id: parent.id,
        count: 2,
        kind: 'decision',
        dedupe_key: `user:${ALICE.id}:proposal:${parent.id}`,
      }),
    ]);

    await services.agents.update(ALICE, lead, {
      delegationTargetIds: [helper],
    });
    const delegated = (
      await call('POST', '/issues', { title: 'D', executor: helper })
    ).body.data as AgentCreateIssueResponse;
    expect(delegated.proposal?.status).toBe('autoAccepted');
    expect(delegated.issue.executor).toMatchObject({
      type: 'agent',
      id: helper,
    });
    expect(await triggerTypes(delegated.issue.id)).toEqual(['assign']);

    // Accept one on the child, then the rest from the parent: the card resolves when none is pending.
    const accepted = await services.proposals.accept(
      ALICE,
      pending1.issue.id,
      pending1.proposal!.id,
      {},
    );
    expect(accepted.status).toBe('accepted');
    expect(await triggerTypes(pending1.issue.id)).toEqual(['proposalAccepted']);
    expect(
      (await rows(db!, 'inbox_items', "type = 'proposal_pending'"))[0]!
        .resolved_at,
    ).toBeNull();
    const all = await services.proposals.acceptAll(ALICE, parent.identifier);
    expect(all.accepted.map((item) => item.issueId)).toEqual([
      pending2.issue.id,
    ]);
    expect(all.skipped).toEqual([]);
    expect(
      (await rows(db!, 'inbox_items', "type = 'proposal_pending'"))[0]!
        .resolved_at,
    ).not.toBeNull();
    const detail = await services.issueQueries.detail(ALICE, parent.id);
    expect(detail.proposals.map((item) => item.status).sort()).toEqual([
      'accepted',
      'accepted',
      'autoAccepted',
    ]);
  });

  it('refuses to accept for a user without access to the proposed agent', async () => {
    const { call } = await claimParent(false);
    const proposed = (
      await call('POST', '/issues', { title: 'P', executor: helper })
    ).body.data as AgentCreateIssueResponse;
    // Helper is ownerOnly (Alice): Bob may see the issue but not invoke the agent.
    await expect(
      services.proposals.accept(
        BOB,
        proposed.issue.id,
        proposed.proposal!.id,
        {},
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const skipped = await services.proposals.acceptAll(
      BOB,
      proposed.issue.parentIssueId!,
    );
    expect(skipped.accepted).toEqual([]);
    expect(skipped.skipped).toEqual([
      expect.objectContaining({
        proposalId: proposed.proposal!.id,
        code: 'FORBIDDEN',
      }),
    ]);
    const rejected = await services.proposals.reject(
      BOB,
      proposed.issue.id,
      proposed.proposal!.id,
      { reason: 'not now' },
    );
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'not now' });
    await expect(
      services.proposals.accept(
        ALICE,
        proposed.issue.id,
        proposed.proposal!.id,
        {},
      ),
    ).rejects.toMatchObject({ code: 'PROPOSAL_DECIDED' });
  });
});
