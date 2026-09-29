/**
 * Inbox items for workflow stage actions (NP-77 proposal §1–§3):
 *
 * | event                      | item                                                                               |
 * | -------------------------- | ---------------------------------------------------------------------------------- |
 * | issue.stageEntered         | info `stage_entered` to the owner (a `notifyOwner` action; not for their own move) |
 * | issue.stageActionReported  | info `stage_action_problem` to the owner (an action skipped, failed or suppressed) |
 * | approval.stale             | info `approval_stale` to the approvers and the requester (the owner when an agent asked), except the approver who decided |
 *
 * payloads: `from`, `to`, `message` / `statusKey`, `action`, `outcome`, `reason` / `requestId`, `fromStatus`,
 * `toStatus`, `code`, `message`.
 */
import type { DomainEvent, EventActor } from '../shared/events.js';
import { findIssue } from '../issue/issue.records.js';
import type { Round } from './round.js';

const SYSTEM: EventActor = { type: 'system', id: null };

export async function onStageEntered(
  round: Round,
  event: Extract<DomainEvent, { type: 'issue.stageEntered' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue?.ownerUserId) return;
  await round.notify(issue, [issue.ownerUserId], event.actor, {
    type: 'stage_entered',
    kind: 'info',
    body: event.message ?? `The issue entered ${event.to}.`,
    payload: { from: event.from, to: event.to, message: event.message },
    dedupeKey: `user:${issue.ownerUserId}:stage_entered:${issue.id}:${event.to}`,
  });
}

export async function onStageActionReported(
  round: Round,
  event: Extract<DomainEvent, { type: 'issue.stageActionReported' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue?.ownerUserId) return;
  await round.notify(issue, [issue.ownerUserId], SYSTEM, {
    type: 'stage_action_problem',
    kind: 'info',
    body: `The ${event.action} action of ${event.statusKey} was ${event.outcome}${event.reason ? ` (${event.reason})` : ''}.`,
    payload: {
      statusKey: event.statusKey,
      action: event.action,
      outcome: event.outcome,
      reason: event.reason,
    },
    dedupeKey: `user:${issue.ownerUserId}:stage_action_problem:${issue.id}:${event.statusKey}:${event.action}`,
  });
}

export async function onApprovalStale(
  round: Round,
  event: Extract<DomainEvent, { type: 'approval.stale' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue) return;
  const requester =
    event.requestedBy.type === 'user'
      ? event.requestedBy.id
      : issue.ownerUserId;
  const recipients = await round.existingUsers([
    ...event.approverUserIds,
    requester,
  ]);
  await round.notify(issue, recipients, event.actor, {
    type: 'approval_stale',
    kind: 'info',
    body: `Moving to ${event.toStatus} was approved but no longer meets its entry conditions: ${event.message}`,
    payload: {
      requestId: event.requestId,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      code: event.code,
      message: event.message,
    },
  });
}
