/**
 * Inbox items for signals (protocol.phase2-signals.ts):
 *
 * | event                  | item                                                                                  |
 * | ---------------------- | ------------------------------------------------------------------------------------- |
 * | issue.signalSuppressed | info `signal_suppressed` to the owner: the rule's limit of runs in a row was reached   |
 *
 * payload: `kind`, `title`, `url`, `limit`.
 */
import type { DomainEvent, EventActor } from '../shared/events.js';
import { findIssue } from '../issue/issue.records.js';
import type { Round } from './round.js';

const SYSTEM: EventActor = { type: 'system', id: null };

export async function onSignalSuppressed(
  round: Round,
  event: Extract<DomainEvent, { type: 'issue.signalSuppressed' }>,
): Promise<void> {
  const issue = await findIssue(round.tx.conn, event.issueId);
  if (!issue?.ownerUserId) return;
  await round.notify(issue, [issue.ownerUserId], SYSTEM, {
    type: 'signal_suppressed',
    kind: 'info',
    body: `${event.title} — the agent already tried ${event.limit} times in a row; it will not be woken again until the problem is resolved.`,
    payload: {
      kind: event.kind,
      title: event.title,
      url: event.url,
      limit: event.limit,
    },
    dedupeKey: `user:${issue.ownerUserId}:signal_suppressed:${issue.id}:${event.kind}`,
  });
}
