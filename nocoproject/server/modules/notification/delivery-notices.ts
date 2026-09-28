/**
 * Inbox items for the iteration 2 delivery chain (docs/phase1/iteration-2-contract.md §C, §D):
 *
 * | event               | item                                                                                     |
 * | ------------------- | ---------------------------------------------------------------------------------------- |
 * | approval.requested  | decision `approval_pending` to each approver (`user:<uid>:approval_pending:<issueId>`)    |
 * | approval.decided    | resolves the approvers' cards; approved / rejected → info `approval_decided` to the member |
 * |                     | who asked, or to the issue owner when an agent asked (not for cancellations)              |
 * | pr.reviewRequested  | decision `pr_review` to the owner (`user:<owner>:pr_review:<issueId>`), held until the    |
 * |                     | issue is in_review (or terminal); entering in_review releases it (NP-128)               |
 * | pr.merged           | info `pr_merged` to the subscribers                                                      |
 * | pr.closed           | resolves the issues' `pr_review` cards                                                   |
 */
import type { DomainEvent, EventActor } from '../shared/events.js';
import type { IssueV1 } from '../shared/protocol.js';
import { pullRequestsForIssue } from '../git/git.records.js';
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

interface ReadyPullRequest {
  readonly pullRequestId: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
}

async function notifyPullRequestReview(
  round: Round,
  issue: IssueV1,
  pr: ReadyPullRequest,
): Promise<void> {
  if (!issue.ownerUserId) return;
  await round.notify(issue, [issue.ownerUserId], SYSTEM, {
    type: 'pr_review',
    kind: 'decision',
    body: `Pull request ${pr.repo}#${pr.number} is ready to merge.`,
    payload: {
      pullRequestId: pr.pullRequestId,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
    },
    dedupeKey: `user:${issue.ownerUserId}:pr_review:${issue.id}`,
  });
}

/**
 * NP-128: the owner accepts the delivery (`review_requested`) before merging, so the merge card waits while the agent
 * is still working — the PR is usually opened before the issue moves to in_review.
 */
export async function onPullRequestReview(
  round: Round,
  event: Extract<DomainEvent, { type: 'pr.reviewRequested' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue?.ownerUserId) return;
  const view = await round.deps.workflows.forIssue(round.tx.conn, issue);
  if (issue.statusKey !== 'in_review' && !view.isTerminal(issue.statusKey))
    return;
  await notifyPullRequestReview(round, issue, event);
}

/** The issue entered in_review: the held `pr_review` card of an agent-executed issue follows the delivery. */
export async function releasePullRequestReviews(
  round: Round,
  issue: IssueV1,
): Promise<void> {
  if (issue.executorType !== 'agent' || !issue.ownerUserId) return;
  const prs = await pullRequestsForIssue(
    round.tx.conn,
    round.deps.users,
    issue.id,
  );
  for (const pr of prs)
    if (pr.state === 'open' && !pr.draft)
      await notifyPullRequestReview(round, issue, {
        pullRequestId: pr.id,
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
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
