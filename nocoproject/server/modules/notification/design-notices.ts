/**
 * Inbox items for the design-first process (docs/phase1/iteration-4-contract.md §B):
 *
 * | event / change                     | item                                                                         |
 * | ---------------------------------- | ---------------------------------------------------------------------------- |
 * | status enters proposal_review      | decision `design_review` to the owner (`user:<owner>:design_review:<issueId>`) |
 * | design.proposed while in review    | the same card, merged with the new proposal (count + 1, unread again)        |
 * | status leaves proposal_review      | resolves the issue's `design_review` cards                                   |
 * | design.decided                     | resolves them too (approve / request changes from any status)               |
 *
 * payload: `proposalCommentId`, `summary` (the first 300 characters of the latest proposal), `from`.
 */
import type { DomainEvent, EventActor } from '../shared/events.js';
import type { IssueV1 } from '../shared/protocol.js';
import {
  DESIGN_REVIEW_SUMMARY_LENGTH,
  STATUS_PROPOSAL_REVIEW,
} from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';
import { latestProposal } from '../issue/process.js';
import { resolveItems } from './inbox.store.js';
import type { Round } from './round.js';

async function deliverReview(
  round: Round,
  issue: IssueV1,
  actor: EventActor,
  from: string | null,
): Promise<void> {
  if (!issue.ownerUserId) return;
  const proposal = await latestProposal(round.tx.conn, issue.id);
  await round.notify(issue, [issue.ownerUserId], actor, {
    type: 'design_review',
    kind: 'decision',
    body: 'A design proposal is waiting for your review.',
    payload: {
      proposalCommentId: proposal?.commentId ?? null,
      summary: (proposal?.content ?? '').slice(0, DESIGN_REVIEW_SUMMARY_LENGTH),
      from,
    },
    dedupeKey: `user:${issue.ownerUserId}:design_review:${issue.id}`,
  });
}

/** A status change of the issue; returns the member who got a decision card (left out of `status_changed`). */
export async function onDesignStatus(
  round: Round,
  issue: IssueV1,
  actor: EventActor,
  status: { readonly from: string; readonly to: string },
): Promise<string | null> {
  if (status.from === STATUS_PROPOSAL_REVIEW && status.to !== status.from)
    round.touch(
      await resolveItems(round.tx, {
        type: 'design_review',
        issueId: issue.id,
      }),
    );
  if (status.to !== STATUS_PROPOSAL_REVIEW) return null;
  await deliverReview(round, issue, actor, status.from);
  return issue.ownerUserId;
}

export async function onDesignProposed(
  round: Round,
  event: Extract<DomainEvent, { type: 'design.proposed' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue || issue.statusKey !== STATUS_PROPOSAL_REVIEW) return;
  await deliverReview(round, issue, event.actor, null);
}

export async function onDesignDecided(
  round: Round,
  event: Extract<DomainEvent, { type: 'design.decided' }>,
): Promise<void> {
  round.touch(
    await resolveItems(round.tx, {
      type: 'design_review',
      issueId: event.issueId,
    }),
  );
}
