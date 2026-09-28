import { ACTIVE_RUN_STATUSES } from '../../constants.js';
import type {
  CommentThread,
  IssueComment,
  QueuedRun,
  RunSummary,
} from '../../types.js';

/**
 * Session mode (iteration 2 §J): the issue as a conversation. Messages are the top-level comments, oldest first; a
 * message typed while the agent is working becomes the next turn, which the panel announces from `queuedRun`.
 */

export function sessionMessages(
  threads: readonly CommentThread[],
): IssueComment[] {
  // A conversation is flat: an agent answers a message as a threaded reply, so replies are messages too, in the
  // order they were written.
  return threads
    .flatMap((thread) => [thread.root, ...thread.replies])
    .filter((comment) => comment.kind !== 'system')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The run the conversation is in: the newest run that has not finished. */
export function activeSessionRun(
  runs: readonly RunSummary[],
): RunSummary | null {
  return (
    [...runs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .find(
        (run) => ACTIVE_RUN_STATUSES.has(run.status) && run.status !== 'queued',
      ) ?? null
  );
}

export type SessionHint =
  | { readonly kind: 'queued'; readonly count: number }
  | { readonly kind: 'working' }
  | null;

/**
 * "Will be sent after this turn (N queued)" while a run is working and another waits with N triggers; "the agent is
 * working, new messages go out after this turn" while it works with nothing queued; nothing when idle.
 */
export function sessionHint(
  activeRun: RunSummary | null,
  queuedRun: QueuedRun | null,
): SessionHint {
  if (!activeRun) return null;
  if (queuedRun && queuedRun.id !== activeRun.id) {
    return { kind: 'queued', count: Math.max(queuedRun.triggerCount, 1) };
  }
  return { kind: 'working' };
}
