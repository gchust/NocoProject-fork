/**
 * Inbox items for iteration 3 (docs/phase1/iteration-3-contract.md §B, §E):
 *
 * | event              | item                                                                                        |
 * | ------------------ | ------------------------------------------------------------------------------------------- |
 * | knowledge.proposed | decision `knowledge_proposal` to each decider (`user:<uid>:knowledge_proposal:<proposalId>`) |
 * | knowledge.decided  | resolves that proposal's cards; info `knowledge_decided` to the source issue's owner         |
 * | delivery.decided   | resolves the issue's `review_requested` cards (also when acceptance waits for approval)     |
 *
 * The events carry the payload fields, so this module never reads the knowledge tables.
 */
import type { DomainEvent } from '../shared/events.js';
import { findIssue } from '../issue/issue.records.js';
import { resolveByDedupeSuffix, resolveItems } from './inbox.store.js';
import type { Round } from './round.js';

export async function onKnowledgeProposed(
  round: Round,
  event: Extract<DomainEvent, { type: 'knowledge.proposed' }>,
): Promise<void> {
  if (!event.issueId) return;
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const recipients = await round.existingUsers(event.deciderUserIds);
  for (const userId of recipients)
    await round.notify(issue, [userId], event.actor, {
      type: 'knowledge_proposal',
      kind: 'decision',
      body: event.isNew
        ? `An agent proposes a new knowledge document "${event.docTitle}".`
        : `An agent proposes an update to the knowledge document "${event.docTitle}".`,
      payload: {
        proposalId: event.proposalId,
        docId: event.docId,
        docTitle: event.docTitle,
        projectId: event.projectId,
        projectName: event.projectName,
        reason: event.reason,
        summary: event.summary,
        issueId: issue.id,
        isNew: event.isNew,
      },
      dedupeKey: `user:${userId}:knowledge_proposal:${event.proposalId}`,
    });
}

export async function onKnowledgeDecided(
  round: Round,
  event: Extract<DomainEvent, { type: 'knowledge.decided' }>,
): Promise<void> {
  round.touch(
    await resolveByDedupeSuffix(
      round.tx,
      'knowledge_proposal',
      `:knowledge_proposal:${event.proposalId}`,
    ),
  );
  if (!event.issueId) return;
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue?.ownerUserId) return;
  await round.notify(issue, [issue.ownerUserId], event.actor, {
    type: 'knowledge_decided',
    kind: 'info',
    body:
      event.decision === 'accepted'
        ? `The knowledge proposal for "${event.docTitle}" was accepted.`
        : `The knowledge proposal for "${event.docTitle}" was rejected.`,
    payload: {
      proposalId: event.proposalId,
      docId: event.docId,
      docTitle: event.docTitle,
      decision: event.decision,
      version: event.version,
      comment: event.comment,
    },
  });
}

export async function onDeliveryDecided(
  round: Round,
  event: Extract<DomainEvent, { type: 'delivery.decided' }>,
): Promise<void> {
  round.touch(
    await resolveItems(round.tx, {
      type: 'review_requested',
      issueId: event.issueId,
    }),
  );
}
