/**
 * Domain events every issue write emits: `issue.changed` for realtime invalidation and `issue.updated` (what
 * changed) for the notification module.
 */
import type { Actor } from '../shared/activity.js';
import type { Tx } from '../shared/db.js';
import type { EventActor, IssueChangeSet } from '../shared/events.js';
import type { IssueV1 } from '../shared/protocol.js';

export function eventActor(actor: Actor): EventActor {
  return { type: actor.type, id: actor.id };
}

export function changeSet(
  before: IssueV1,
  after: IssueV1,
  mentionedUserIds: string[],
): IssueChangeSet {
  return {
    ...(before.statusKey !== after.statusKey
      ? { status: { from: before.statusKey, to: after.statusKey } }
      : {}),
    ...(before.ownerUserId !== after.ownerUserId
      ? { owner: { from: before.ownerUserId, to: after.ownerUserId } }
      : {}),
    ...(before.executorType !== after.executorType ||
    before.executorId !== after.executorId
      ? {
          executor: {
            from: { type: before.executorType, id: before.executorId },
            to: { type: after.executorType, id: after.executorId },
          },
        }
      : {}),
    ...(mentionedUserIds.length > 0 ? { mentionedUserIds } : {}),
  };
}

export function emitUpdate(
  tx: Tx,
  before: IssueV1,
  after: IssueV1,
  actor: Actor,
  mentionedUserIds: string[] = [],
): void {
  tx.emit({ type: 'issue.changed', issueId: after.id });
  const changes = changeSet(before, after, mentionedUserIds);
  if (Object.keys(changes).length > 0)
    tx.emit({
      type: 'issue.updated',
      issueId: after.id,
      actor: eventActor(actor),
      changes,
    });
}
