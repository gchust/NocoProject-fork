/**
 * The plan-only rows (NP-183, protocol-pm-assistant.md §4.2): resolving one of the owner's decision cards and creating
 * a project, both through the browser services inside the plan's transaction.
 *
 * | Card               | Actions                                   | Service                                  |
 * | ------------------ | ----------------------------------------- | ---------------------------------------- |
 * | `proposal_pending` | `accept` / `dismiss` every pending one    | proposals accept / reject                |
 * | `design_review`    | `approve` / `request_changes` (comment)   | design approve / requestChanges          |
 * | `knowledge_proposal` | `accept` / `reject`                     | knowledge decide                         |
 *
 * Other cards are 400 `UNSUPPORTED_DECISION`; somebody else's card, or one already resolved, is 404.
 */
import type { Actor } from '../shared/activity.js';
import type { Tx } from '../shared/db.js';
import { fromJson, str, unique } from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { PmOperation } from '../shared/protocol.js';
import type { DesignService } from '../issue/design.service.js';
import type { KnowledgeService } from '../knowledge/knowledge.service.js';
import type { ProjectService } from '../project/project.service.js';
import type { ProposalService } from '../subtask/proposal.service.js';
import type { PerformedObject } from './pm.operations.js';

export interface DecisionDeps {
  readonly proposals: () => ProposalService;
  readonly design: () => DesignService;
  readonly knowledge: () => KnowledgeService;
  readonly projects: () => ProjectService;
}

type Decision = Extract<PmOperation, { type: 'decision.resolve' }>;

function unsupported(): never {
  throw invalid(
    'UNSUPPORTED_DECISION',
    'This decision cannot be made from a plan.',
  );
}

async function pendingProposals(tx: Tx, parentId: string) {
  const children = await tx.conn.query
    .selectFrom('issues')
    .select('id')
    .where('parentIssueId', '=', parentId)
    .execute();
  const ids = unique([parentId, ...children.map((row) => str(row.id))]);
  return tx.conn.query
    .selectFrom('executorProposals')
    .select(['id', 'issueId'])
    .where('issueId', 'in', ids)
    .where('status', '=', 'pending')
    .orderBy('createdAt', 'asc')
    .execute();
}

async function resolveDecision(
  deps: DecisionDeps,
  tx: Tx,
  actor: Actor,
  op: Decision,
): Promise<PerformedObject> {
  const { inboxItemId, action, comment } =
    op.params ?? ({} as Decision['params']);
  const item = await tx.conn.query
    .selectFrom('inboxItems')
    .selectAll()
    .where('id', '=', inboxItemId ?? '')
    .executeTakeFirst();
  if (!item || item.userId !== actor.id || item.resolvedAt)
    throw notFound('Decision');
  const issueId = str(item.issueId);
  const payload = fromJson<Record<string, unknown>>(item.payload) ?? {};
  const object: PerformedObject = {
    type: 'issue',
    id: issueId ?? inboxItemId,
    budgetKey: { objectType: 'decision', objectId: inboxItemId },
  };
  switch (item.type) {
    case 'proposal_pending': {
      if (action !== 'accept' && action !== 'dismiss') unsupported();
      const parentId = str(payload.parentIssueId) ?? issueId ?? '';
      for (const proposal of await pendingProposals(tx, parentId)) {
        const decide = action === 'accept' ? 'accept' : 'reject';
        await deps
          .proposals()
          [decide](
            actor,
            String(proposal.issueId),
            String(proposal.id),
            {},
            tx,
          );
      }
      return object;
    }
    case 'design_review':
      if (!issueId) throw notFound('Issue');
      if (action === 'approve')
        await deps.design().approve(actor, issueId, { comment }, tx);
      else if (action === 'request_changes')
        await deps
          .design()
          .requestChanges(actor, issueId, { comment: comment ?? '' }, tx);
      else unsupported();
      return object;
    case 'knowledge_proposal': {
      if (action !== 'accept' && action !== 'reject') unsupported();
      const proposalId = str(payload.proposalId) ?? '';
      await deps.knowledge().decide(actor, proposalId, action, { comment }, tx);
      return { ...object, type: 'knowledgeProposal', id: proposalId };
    }
    default:
      unsupported();
  }
}

export async function performDecision(
  deps: DecisionDeps,
  tx: Tx,
  actor: Actor,
  op: Extract<PmOperation, { type: 'decision.resolve' | 'project.create' }>,
): Promise<PerformedObject> {
  if (op.type === 'decision.resolve')
    return resolveDecision(deps, tx, actor, op);
  const project = await deps.projects().create(
    actor,
    {
      name: op.params?.name,
      description: op.params?.description,
      ...(op.params?.visibility
        ? {
            visibility:
              op.params.visibility === 'private' ? 'members' : 'everyone',
          }
        : {}),
    } as never,
    tx,
  );
  return {
    type: 'project',
    id: project.id,
    title: project.name,
    budgetKey: { objectType: 'project', objectId: project.id },
  };
}
