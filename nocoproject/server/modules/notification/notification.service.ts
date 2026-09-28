/**
 * Turns domain events into subscriptions and inbox items (docs/phase1/iteration-1-contract.md §E). It runs inside the
 * transaction that produced the events (`createTxRunner`'s `beforeCommit` hook), so an inbox item exists exactly when
 * the change that caused it does.
 *
 * | type                | kind     | recipient          | when                                                      |
 * | ------------------- | -------- | ------------------ | --------------------------------------------------------- |
 * | review_requested    | decision | owner              | an agent moves the issue to in_review                     |
 * | agent_blocked       | decision | owner              | an agent moves it to blocked, or a run fails agentBlocked |
 * | proposal_pending    | decision | parent owner       | an executor proposal is left pending (one card per parent) |
 * | batch_done          | info     | parent owner       | a batch of sub-issues is terminal                         |
 * | dependency_released | info     | owner              | nothing blocks the issue any more and it has no executor  |
 * | run_failed          | info     | subscribers        | a run failed for good (no retry)                          |
 * | owner_assigned      | info     | new owner          | the owner changed (not for agent-created sub-issues)      |
 * | executor_assigned   | info     | executor (member)  | the executor became a member                              |
 * | mentioned           | info     | mentioned member   | `mention://user/<id>` in a comment or the description     |
 * | commented           | info     | subscribers        | a new comment (mentioned members get `mentioned` instead) |
 * | status_changed      | info     | subscribers        | status changed by a user or an agent (not by the system)  |
 * | approval_pending    | decision | each approver      | a status change waits for approval (iteration 2)          |
 * | approval_decided    | info     | requester (member), else the owner | the request was approved or rejected      |
 * | pr_review           | decision | owner              | a ready PR on an issue executed by an agent               |
 * | pr_merged           | info     | subscribers        | a linked PR was merged                                    |
 * | knowledge_proposal  | decision | project lead(s), else owner/admin | an agent proposed a knowledge change (iteration 3) |
 * | knowledge_decided   | info     | source issue owner | the proposal was accepted or rejected                     |
 * | design_review       | decision | owner              | the issue enters proposal_review (iteration 4, `design-notices.ts`) |
 * | stage_entered, stage_action_problem, approval_stale | info | owner / approvers | workflow stage actions (Phase 2, `stage-notices.ts`) |
 * | workflow_proposal   | decision | owner/admin        | an agent proposed a workflow template change (Phase 2, `workflow-notices.ts`) |
 * | workflow_decided    | info     | source issue owner | the template proposal was accepted, rejected or found stale |
 *
 * Nobody is notified of their own action. Decision items resolve when the matching action is done (status leaves
 * in_review / blocked; every proposal on the parent decided; the approval request decided or cancelled; the PR merged
 * or closed; the knowledge or workflow proposal decided; a delivery accepted or sent back — iteration 3; the design approved or
 * sent back, or the status leaving proposal_review — iteration 4). An agent's `/note` notifies nobody (the project
 * manager's retrospective notes). `agent_blocked` also
 * resolves for a member who replies on the issue (not a `/note`) and for everyone when the executor changes. `run_failed` items are archived when the issue reaches in_review or a terminal status. Every recipient
 * gets `inbox.changed` (realtime `np:inbox`). `body` is an English fallback; `payload` carries what the browser
 * renders from (`type` + `payload`), including `identifier` and `issueTitle` on every item.
 */
import type { Tx } from '../shared/db.js';
import { str, unique } from '../shared/db.js';
import type { DomainEvent, EventActor } from '../shared/events.js';
import type { IssueV1 } from '../shared/protocol.js';
import { isNote } from '../collaboration/mentions.js';
import { findIssue } from '../issue/issue.records.js';
import {
  onApprovalDecided,
  onApprovalRequested,
  onPullRequestClosed,
  onPullRequestMerged,
  onPullRequestReview,
} from './delivery-notices.js';
import {
  onDesignDecided,
  onDesignProposed,
  onDesignStatus,
} from './design-notices.js';
import {
  activeSubscribers,
  archiveRunFailed,
  resolveItems,
} from './inbox.store.js';
import {
  onDeliveryDecided,
  onKnowledgeDecided,
  onKnowledgeProposed,
} from './knowledge-notices.js';
import { Round, type NotificationDeps } from './round.js';
import {
  onApprovalStale,
  onStageActionReported,
  onStageEntered,
} from './stage-notices.js';
import { onWorkflowDecided, onWorkflowProposed } from './workflow-notices.js';

export type { NotificationDeps } from './round.js';

export interface NotificationService {
  process(tx: Tx, events: readonly DomainEvent[]): Promise<void>;
}

const SYSTEM: EventActor = { type: 'system', id: null };
const EXCERPT_LENGTH = 200;

async function onIssueCreated(
  round: Round,
  event: Extract<DomainEvent, { type: 'issue.created' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const { actor } = event;
  if (actor.type === 'user')
    await round.subscribe(issue.id, [actor.id], 'creator');
  await round.subscribe(issue.id, [issue.ownerUserId], 'owner');
  const executorUser = issue.executorType === 'user' ? issue.executorId : null;
  await round.subscribe(issue.id, [executorUser], 'executor');
  const mentioned = await round.existingUsers(event.mentionedUserIds);
  await round.subscribe(issue.id, mentioned, 'mentioned');
  if (actor.type === 'user')
    await round.notify(issue, [issue.ownerUserId], actor, {
      type: 'owner_assigned',
      kind: 'info',
      body: 'You were made the owner.',
    });
  await round.notify(issue, [executorUser], actor, {
    type: 'executor_assigned',
    kind: 'info',
    body: 'You were assigned as the executor.',
  });
  await round.notify(issue, mentioned, actor, {
    type: 'mentioned',
    kind: 'info',
    body: 'You were mentioned in the description.',
    payload: { source: 'description' },
  });
}

async function onStatusChanged(
  round: Round,
  issue: IssueV1,
  actor: EventActor,
  status: { from: string; to: string },
): Promise<void> {
  const { tx } = round;
  const view = await round.deps.workflows.forIssue(tx.conn, issue);
  if (status.from === 'in_review' && status.to !== 'in_review')
    round.touch(
      await resolveItems(tx, { type: 'review_requested', issueId: issue.id }),
    );
  if (status.to !== 'blocked')
    round.touch(
      await resolveItems(tx, { type: 'agent_blocked', issueId: issue.id }),
    );
  if (status.to === 'in_review' || view.isTerminal(status.to))
    round.touch(await archiveRunFailed(tx, issue.id));
  const deciders: string[] = [];
  if (actor.type === 'agent' && issue.ownerUserId) {
    if (status.to === 'in_review' || status.to === 'blocked') {
      deciders.push(issue.ownerUserId);
      await round.notify(issue, [issue.ownerUserId], actor, {
        type: status.to === 'in_review' ? 'review_requested' : 'agent_blocked',
        kind: 'decision',
        body:
          status.to === 'in_review'
            ? 'The agent delivered and asks for review.'
            : 'The agent is blocked and needs you.',
        payload: { from: status.from, to: status.to },
      });
    }
  }
  const designDecider = await onDesignStatus(round, issue, actor, status);
  if (designDecider) deciders.push(designDecider);
  if (actor.type === 'system') return;
  const subscribers = (await activeSubscribers(tx.conn, issue.id)).filter(
    (userId) => !deciders.includes(userId),
  );
  await round.notify(issue, subscribers, actor, {
    type: 'status_changed',
    kind: 'info',
    body: `Status changed from ${status.from} to ${status.to}.`,
    payload: { from: status.from, to: status.to },
  });
}

async function onIssueUpdated(
  round: Round,
  event: Extract<DomainEvent, { type: 'issue.updated' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const { actor, changes } = event;
  if (changes.owner?.to) {
    await round.subscribe(issue.id, [changes.owner.to], 'owner');
    const fromName = changes.owner.from
      ? ((
          await round.deps.users.names(round.tx.conn, [changes.owner.from])
        ).get(changes.owner.from) ?? null)
      : null;
    await round.notify(issue, [changes.owner.to], actor, {
      type: 'owner_assigned',
      kind: 'info',
      body: 'You were made the owner.',
      payload: { from: changes.owner.from, fromName },
    });
  }
  // A reassigned issue no longer waits on the blocked agent (iteration 3 §E `reassign`).
  if (changes.executor)
    round.touch(
      await resolveItems(round.tx, {
        type: 'agent_blocked',
        issueId: issue.id,
      }),
    );
  if (changes.executor?.to.type === 'user' && changes.executor.to.id) {
    await round.subscribe(issue.id, [changes.executor.to.id], 'executor');
    await round.notify(issue, [changes.executor.to.id], actor, {
      type: 'executor_assigned',
      kind: 'info',
      body: 'You were assigned as the executor.',
    });
  }
  if (changes.mentionedUserIds?.length) {
    const mentioned = await round.existingUsers(changes.mentionedUserIds);
    await round.subscribe(issue.id, mentioned, 'mentioned');
    await round.notify(issue, mentioned, actor, {
      type: 'mentioned',
      kind: 'info',
      body: 'You were mentioned in the description.',
      payload: { source: 'description' },
    });
  }
  if (changes.status)
    await onStatusChanged(round, issue, actor, changes.status);
}

async function onComment(
  round: Round,
  event: Extract<DomainEvent, { type: 'comment.created' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const { actor } = event;
  if (actor.type === 'user')
    await round.subscribe(issue.id, [actor.id], 'commenter');
  const mentioned = await round.existingUsers(event.mentionedUserIds);
  await round.subscribe(issue.id, mentioned, 'mentioned');
  const comment = await round.tx.conn.query
    .selectFrom('comments')
    .select('content')
    .where('id', '=', event.commentId)
    .executeTakeFirst();
  const content = str(comment?.content) ?? '';
  // Iteration 4: an agent's note (the project manager's retrospective) notifies nobody.
  if (actor.type === 'agent' && isNote(content)) return;
  // A member's reply to a blocked agent is their decision (iteration 3 §E `reply`); a note does not reach the agent.
  if (actor.type === 'user' && !isNote(content))
    round.touch(
      await resolveItems(round.tx, {
        type: 'agent_blocked',
        issueId: issue.id,
        userId: actor.id,
      }),
    );
  const payload = {
    commentId: event.commentId,
    source: 'comment',
    excerpt: content.slice(0, EXCERPT_LENGTH),
  };
  await round.notify(issue, mentioned, actor, {
    type: 'mentioned',
    kind: 'info',
    body: 'You were mentioned in a comment.',
    payload,
  });
  const subscribers = (await activeSubscribers(round.tx.conn, issue.id)).filter(
    (userId) => !mentioned.includes(userId),
  );
  await round.notify(issue, subscribers, actor, {
    type: 'commented',
    kind: 'info',
    body: 'New comment.',
    payload,
  });
}

async function onRunFailed(
  round: Round,
  event: Extract<DomainEvent, { type: 'run.failed' }>,
): Promise<void> {
  if (!event.final) return;
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const actor: EventActor = { type: 'agent', id: event.agentId };
  const payload = {
    runId: event.runId,
    agentId: event.agentId,
    agentName: (await round.actorName(actor)) ?? null,
    reason: event.reason,
  };
  const deciders: string[] = [];
  if (event.reason === 'agentBlocked' && issue.ownerUserId) {
    deciders.push(issue.ownerUserId);
    await round.notify(issue, [issue.ownerUserId], actor, {
      type: 'agent_blocked',
      kind: 'decision',
      body: 'The agent stopped because it is blocked.',
      payload,
    });
  }
  const subscribers = (await activeSubscribers(round.tx.conn, issue.id)).filter(
    (userId) => !deciders.includes(userId),
  );
  await round.notify(issue, subscribers, actor, {
    type: 'run_failed',
    kind: 'info',
    body: `A run failed (${event.reason}).`,
    payload,
  });
}

async function pendingProposalCount(tx: Tx, parentId: string): Promise<number> {
  const children = await tx.conn.query
    .selectFrom('issues')
    .select('id')
    .where('parentIssueId', '=', parentId)
    .where('deletedAt', 'is', null)
    .execute();
  const ids = unique([parentId, ...children.map((row) => str(row.id))]);
  const rows = await tx.conn.query
    .selectFrom('executorProposals')
    .select('id')
    .where('issueId', 'in', ids)
    .where('status', '=', 'pending')
    .execute();
  return rows.length;
}

async function onProposal(
  round: Round,
  event: Extract<
    DomainEvent,
    { type: 'proposal.created' | 'proposal.decided' }
  >,
): Promise<void> {
  const anchorId = event.parentIssueId ?? event.issueId;
  const anchor = await findIssue(round.tx.conn, anchorId);
  if (!anchor) return;
  const pending = await pendingProposalCount(round.tx, anchor.id);
  if (event.type === 'proposal.decided') {
    if (pending === 0)
      round.touch(
        await resolveItems(round.tx, {
          type: 'proposal_pending',
          issueId: anchor.id,
        }),
      );
    return;
  }
  if (!anchor.ownerUserId) return;
  await round.notify(
    anchor,
    [anchor.ownerUserId],
    event.proposedByAgentId
      ? { type: 'agent', id: event.proposedByAgentId }
      : SYSTEM,
    {
      type: 'proposal_pending',
      kind: 'decision',
      body: `${pending} executor proposal(s) waiting for your decision.`,
      payload: {
        parentIssueId: anchor.id,
        pending,
        lastProposalId: event.proposalId,
      },
      dedupeKey: `user:${anchor.ownerUserId}:proposal:${anchor.id}`,
    },
  );
}

async function onBatchDone(
  round: Round,
  event: Extract<DomainEvent, { type: 'issue.batchDone' }>,
): Promise<void> {
  const parent = await findIssue(round.tx.conn, event.parentIssueId);
  if (!parent?.ownerUserId) return;
  await round.notify(parent, [parent.ownerUserId], SYSTEM, {
    type: 'batch_done',
    kind: 'info',
    body:
      event.stage === null
        ? 'All sub-issues are finished.'
        : `Stage ${event.stage} of the sub-issues is finished.`,
    payload: { stage: event.stage, childIssueIds: event.childIssueIds },
  });
}

async function onDependencyReleased(
  round: Round,
  event: Extract<DomainEvent, { type: 'issue.dependencyReleased' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue?.ownerUserId) return;
  const releasedBy = await findIssue(round.tx.conn, event.releasedBy);
  await round.notify(issue, [issue.ownerUserId], SYSTEM, {
    type: 'dependency_released',
    kind: 'info',
    body: 'Nothing blocks this issue any more; it has no executor yet.',
    payload: {
      releasedBy: event.releasedBy,
      releasedByIdentifier: releasedBy?.identifier ?? null,
    },
  });
}

async function handle(round: Round, event: DomainEvent): Promise<void> {
  switch (event.type) {
    case 'issue.created':
      return onIssueCreated(round, event);
    case 'issue.updated':
      return onIssueUpdated(round, event);
    case 'comment.created':
      return onComment(round, event);
    case 'run.failed':
      return onRunFailed(round, event);
    case 'proposal.created':
    case 'proposal.decided':
      return onProposal(round, event);
    case 'issue.batchDone':
      return onBatchDone(round, event);
    case 'issue.dependencyReleased':
      return onDependencyReleased(round, event);
    case 'approval.requested':
      return onApprovalRequested(round, event);
    case 'approval.decided':
      return onApprovalDecided(round, event);
    case 'pr.reviewRequested':
      return onPullRequestReview(round, event);
    case 'pr.merged':
      return onPullRequestMerged(round, event);
    case 'pr.closed':
      return onPullRequestClosed(round, event);
    case 'knowledge.proposed':
      return onKnowledgeProposed(round, event);
    case 'knowledge.decided':
      return onKnowledgeDecided(round, event);
    case 'delivery.decided':
      return onDeliveryDecided(round, event);
    case 'design.proposed':
      return onDesignProposed(round, event);
    case 'design.decided':
      return onDesignDecided(round, event);
    case 'issue.stageEntered':
      return onStageEntered(round, event);
    case 'issue.stageActionReported':
      return onStageActionReported(round, event);
    case 'approval.stale':
      return onApprovalStale(round, event);
    case 'workflow.proposed':
      return onWorkflowProposed(round, event);
    case 'workflow.decided':
      return onWorkflowDecided(round, event);
    default:
      return;
  }
}

export function createNotificationService(
  deps: NotificationDeps,
): NotificationService {
  return {
    async process(tx, events) {
      const round = new Round(tx, deps);
      for (const event of events) await handle(round, event);
      for (const userId of round.touched)
        tx.emit({ type: 'inbox.changed', userId });
    },
  };
}
