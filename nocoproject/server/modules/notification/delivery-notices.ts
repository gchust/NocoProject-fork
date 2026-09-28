/**
 * Inbox items for the iteration 2 delivery chain (docs/phase1/iteration-2-contract.md §C, §D):
 *
 * | event               | item                                                                                     |
 * | ------------------- | ---------------------------------------------------------------------------------------- |
 * | approval.requested  | decision `approval_pending` to each approver (`user:<uid>:approval_pending:<issueId>`)    |
 * | approval.decided    | resolves the approvers' cards; approved / rejected → info `approval_decided` to the member |
 * |                     | who asked, or to the issue owner when an agent asked (not for cancellations)              |
 * | pr.reviewRequested  | decision `pr_review` to the owner (`user:<owner>:pr_review:<issueId>`)                    |
 * | pr.merged           | info `pr_merged` to the subscribers                                                      |
 * | pr.closed           | resolves the issues' `pr_review` cards                                                   |
 */
import type { DomainEvent, EventActor } from '../shared/events.js';
import { findIssue, issuesByIds } from '../issue/issue.records.js';
import { activeSubscribers, resolveItems } from './inbox.store.js';
import type { Round } from './round.js';

const SYSTEM: EventActor = { type: 'system', id: null };

export async function onApprovalRequested(
  round: Round,
  event: Extract<DomainEvent, { type: 'approval.requested' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const recipients = await round.existingUsers(event.approverUserIds);
  for (const userId of recipients)
    await round.notify(issue, [userId], event.actor, {
      type: 'approval_pending',
      kind: 'decision',
      body: `Moving to ${event.toStatus} is waiting for your approval.`,
      payload: {
        requestId: event.requestId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        requestedByName: await round.actorName(event.actor),
      },
      dedupeKey: `user:${userId}:approval_pending:${issue.id}`,
    });
}

export async function onApprovalDecided(
  round: Round,
  event: Extract<DomainEvent, { type: 'approval.decided' }>,
): Promise<void> {
  round.touch(
    await resolveItems(round.tx, {
      type: 'approval_pending',
      issueId: event.issueId,
    }),
  );
  if (event.status === 'cancelled') return;
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const recipient =
    event.requestedBy.type === 'user'
      ? event.requestedBy.id
      : issue.ownerUserId;
  await round.notify(issue, [recipient], event.actor, {
    type: 'approval_decided',
    kind: 'info',
    body:
      event.status === 'approved'
        ? `Moving to ${event.toStatus} was approved.`
        : `Moving to ${event.toStatus} was rejected.`,
    payload: {
      requestId: event.requestId,
      decision: event.status,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      comment: event.comment,
      requestedByType: event.requestedBy.type,
    },
  });
}

export async function onPullRequestReview(
  round: Round,
  event: Extract<DomainEvent, { type: 'pr.reviewRequested' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue?.ownerUserId) return;
  await round.notify(issue, [issue.ownerUserId], SYSTEM, {
    type: 'pr_review',
    kind: 'decision',
    body: `Pull request ${event.repo}#${event.number} is ready to merge.`,
    payload: {
      pullRequestId: event.pullRequestId,
      repo: event.repo,
      number: event.number,
      url: event.url,
    },
    dedupeKey: `user:${issue.ownerUserId}:pr_review:${issue.id}`,
  });
}

export async function onPullRequestMerged(
  round: Round,
  event: Extract<DomainEvent, { type: 'pr.merged' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  await round.notify(
    issue,
    await activeSubscribers(round.tx.conn, issue.id),
    SYSTEM,
    {
      type: 'pr_merged',
      kind: 'info',
      body:
        event.statusChangedTo === null
          ? `Pull request ${event.repo}#${event.number} was merged.`
          : `Pull request ${event.repo}#${event.number} was merged; the issue moved to ${event.statusChangedTo}.`,
      payload: {
        repo: event.repo,
        number: event.number,
        url: event.url,
        statusChangedTo: event.statusChangedTo,
      },
    },
  );
}

export async function onPullRequestClosed(
  round: Round,
  event: Extract<DomainEvent, { type: 'pr.closed' }>,
): Promise<void> {
  const issues = await issuesByIds(round.tx.conn, event.issueIds);
  for (const issueId of issues.keys())
    round.touch(await resolveItems(round.tx, { type: 'pr_review', issueId }));
}
