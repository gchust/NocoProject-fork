/**
 * Inbox items for workflow template proposals (NP-77 proposal §4, stage 2):
 *
 * | event             | item                                                                                        |
 * | ----------------- | ------------------------------------------------------------------------------------------- |
 * | workflow.proposed | decision `workflow_proposal` to each owner/admin (`user:<uid>:workflow_proposal:<proposalId>`) |
 * | workflow.decided  | resolves that proposal's cards; info `workflow_decided` to the source issue's owner          |
 *
 * payloads: `proposalId`, `kind`, `templateId`, `templateName`, `copyFromId`, `reason`, `changes` (diff counts),
 * `issueId` / `proposalId`, `kind`, `templateId`, `templateName`, `decision`, `revision`, `comment`. The events carry
 * the payload fields, so this module never reads the proposal tables.
 */
import type { DomainEvent } from '../shared/events.js';
import { findIssue } from '../issue/issue.records.js';
import { resolveByDedupeSuffix } from './inbox.store.js';
import type { Round } from './round.js';

export async function onWorkflowProposed(
  round: Round,
  event: Extract<DomainEvent, { type: 'workflow.proposed' }>,
): Promise<void> {
  if (!event.issueId) return;
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const recipients = await round.existingUsers(event.deciderUserIds);
  for (const userId of recipients)
    await round.notify(issue, [userId], event.actor, {
      type: 'workflow_proposal',
      kind: 'decision',
      body:
        event.kind === 'copy'
          ? `An agent proposes a new workflow template "${event.templateName}".`
          : `An agent proposes a change to the workflow template "${event.templateName}".`,
      payload: {
        proposalId: event.proposalId,
        kind: event.kind,
        templateId: event.templateId,
        templateName: event.templateName,
        copyFromId: event.copyFromId,
        reason: event.reason,
        changes: event.changes,
        issueId: issue.id,
      },
      dedupeKey: `user:${userId}:workflow_proposal:${event.proposalId}`,
    });
}

const RESULT: Record<
  Extract<DomainEvent, { type: 'workflow.decided' }>['decision'],
  string
> = {
  accepted: 'was accepted',
  rejected: 'was rejected',
  stale: 'is stale: the template changed since it was made',
};

export async function onWorkflowDecided(
  round: Round,
  event: Extract<DomainEvent, { type: 'workflow.decided' }>,
): Promise<void> {
  round.touch(
    await resolveByDedupeSuffix(
      round.tx,
      'workflow_proposal',
      `:workflow_proposal:${event.proposalId}`,
    ),
  );
  if (!event.issueId) return;
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue?.ownerUserId) return;
  await round.notify(issue, [issue.ownerUserId], event.actor, {
    type: 'workflow_decided',
    kind: 'info',
    body: `The workflow proposal for "${event.templateName}" ${RESULT[event.decision]}.`,
    payload: {
      proposalId: event.proposalId,
      kind: event.kind,
      templateId: event.templateId,
      templateName: event.templateName,
      decision: event.decision,
      revision: event.revision,
      comment: event.comment,
    },
  });
}
