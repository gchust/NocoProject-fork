// @vitest-environment node
/**
 * Deciding workflow template proposals on a real PostgreSQL (NP-77 stage 2, continued from `np-workflow-proposals`):
 * an outdated base is 409 stale and the proposal becomes `stale`; removing a status issues are in is 409 with counts
 * per project, on submit and again on accept; rejection with a comment resolves the cards and tells the owner.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  WorkflowListItemV5,
  WorkflowProposal,
  WorkflowStatusConflictDetails,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  openNpTestDatabase,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  CODE_REVIEW,
  definitionWith,
  insertTemplate,
  projectOn,
  secondRun,
  setupWorld,
  world,
} from './np-workflow-harness.ts';

const opened = await openNpTestDatabase('np_t_workflow_decisions');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-workflow-decisions] skipped: ${skip}`);
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

describe.skipIf(!db)(
  'workflow template proposal decisions (PostgreSQL)',
  () => {
    it('marks a proposal on an outdated revision stale on acceptance', async () => {
      const custom = await insertTemplate(definitionWith());
      const first = await propose({
        templateId: custom,
        definition: definitionWith([CODE_REVIEW]),
        reason: 'First',
      });
      const second = await propose(
        {
          templateId: custom,
          definition: definitionWith([
            { ...CODE_REVIEW, key: 'qa', name: 'QA' },
          ]),
          reason: 'Second',
        },
        await secondRun(),
      );
      await world.alice(
        'POST',
        `/np/workflows/proposals/${first.body.data.id}/accept`,
      );
      const outdated = await world.alice<Data<WorkflowProposal>>(
        'GET',
        `/np/workflows/proposals/${second.body.data.id}`,
      );
      expect(outdated.body.data).toMatchObject({
        outdated: true,
        canDecide: true,
      });
      const stale = await world.alice(
        'POST',
        `/np/workflows/proposals/${second.body.data.id}/accept`,
      );
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('WORKFLOW_PROPOSAL_STALE');
      const after = await world.alice<Data<WorkflowProposal>>(
        'GET',
        `/np/workflows/proposals/${second.body.data.id}`,
      );
      expect(after.body.data).toMatchObject({
        status: 'stale',
        canDecide: false,
      });
      const template = await world.alice<Data<WorkflowListItemV5>>(
        'GET',
        `/np/workflows/${custom}`,
      );
      expect(template.body.data.revision).toBe(2);
      expect(
        template.body.data.definition.statuses.map((s) => s.key),
      ).toContain('code_review');
    });

    it('refuses removing a status issues are in, with counts per project, on submit and on accept', async () => {
      const custom = await insertTemplate(definitionWith([CODE_REVIEW]));
      const web = await projectOn(custom, 'Web');
      const api = await projectOn(custom, 'Api');
      for (const projectId of [web, web, api])
        await world.services.issues.create(ALICE, {
          title: 'In review',
          projectId,
          statusKey: 'code_review',
        });
      const refused = await propose({
        templateId: custom,
        definition: definitionWith(),
        reason: 'Drop code review',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('WORKFLOW_STATUS_CONFLICT');
      const details = (
        refused.body as unknown as { details: WorkflowStatusConflictDetails }
      ).details;
      expect(details.statuses).toHaveLength(1);
      expect(details.statuses[0]).toMatchObject({
        statusKey: 'code_review',
        total: 3,
      });
      expect(
        Object.fromEntries(
          details.statuses[0]!.projects.map((item) => [
            item.projectName,
            item.count,
          ]),
        ),
      ).toEqual({ Web: 2, Api: 1 });

      // Submitted while nothing is in `qa`; an issue moves there before the decision.
      const other = await insertTemplate(
        definitionWith([{ ...CODE_REVIEW, key: 'qa', name: 'QA' }]),
      );
      const projectId = await projectOn(other, 'Ops');
      const proposed = await propose({
        templateId: other,
        definition: definitionWith(),
        reason: 'Drop QA',
      });
      expect(proposed.status).toBe(201);
      await world.services.issues.create(ALICE, {
        title: 'QA now',
        projectId,
        statusKey: 'qa',
      });
      const accept = await world.alice(
        'POST',
        `/np/workflows/proposals/${proposed.body.data.id}/accept`,
      );
      expect(accept.body.code).toBe('WORKFLOW_STATUS_CONFLICT');
      const still = await world.alice<Data<WorkflowProposal>>(
        'GET',
        `/np/workflows/proposals/${proposed.body.data.id}`,
      );
      expect(still.body.data.status).toBe('pending');
    });

    it('rejects with a comment: cards resolve and the owner learns the result', async () => {
      const custom = await insertTemplate(definitionWith());
      const proposed = await propose({
        templateId: custom,
        definition: definitionWith([CODE_REVIEW]),
        reason: 'Add review',
      });
      const rejected = await world.carol<Data<WorkflowProposal>>(
        'POST',
        `/np/workflows/proposals/${proposed.body.data.id}/reject`,
        { comment: 'Not now.' },
      );
      expect(rejected.body.data).toMatchObject({
        status: 'rejected',
        comment: 'Not now.',
        decidedByName: expect.any(String),
        resultRevision: null,
      });
      expect(await decisionCards(ALICE)).toHaveLength(0);
      const notice = (
        await world.services.inbox.list(BOB, { kind: 'info' })
      ).data.find((item) => item.type === ('workflow_decided' as never));
      expect(notice?.payload).toMatchObject({
        decision: 'rejected',
        comment: 'Not now.',
        templateId: custom,
      });
      expect(
        (
          await world.alice<Data<WorkflowListItemV5>>(
            'GET',
            `/np/workflows/${custom}`,
          )
        ).body.data.revision,
      ).toBe(1);
      expect(
        (await world.alice('GET', '/np/workflows/proposals/missing')).status,
      ).toBe(404);
    });
  },
);
