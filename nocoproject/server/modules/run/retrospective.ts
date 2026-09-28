/**
 * Iteration 4 (docs/phase1/iteration-4-contract.md §C): when a `retrospective` run completes, the `/note` its
 * project manager posted on the issue is recorded as the `retrospective_done` activity (`details.commentId`, plus
 * `runId` from the agent actor). A run that posted no note leaves no activity.
 */
import type { ActivityRecorder } from '../shared/activity.js';
import type { Tx } from '../shared/db.js';
import { str } from '../shared/db.js';
import type { Run } from '../shared/protocol.js';
import { isNote } from '../collaboration/mentions.js';

export async function markRetrospectiveDone(
  tx: Tx,
  activity: ActivityRecorder,
  run: Run,
): Promise<void> {
  const retrospective = await tx.conn.query
    .selectFrom('runTriggers')
    .select('id')
    .where('runId', '=', run.id)
    .where('type', '=', 'retrospective')
    .executeTakeFirst();
  if (!retrospective) return;
  const comments = await tx.conn.query
    .selectFrom('comments')
    .select(['id', 'content'])
    .where('sourceRunId', '=', run.id)
    .where('authorType', '=', 'agent')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const note = comments.find((row) => isNote(str(row.content) ?? ''));
  if (!note) return;
  await activity.record(tx.conn, {
    issueId: run.subjectId,
    actor: { type: 'agent', id: run.agentId, runId: run.id },
    action: 'retrospective_done',
    details: { commentId: str(note.id) },
  });
  tx.emit({ type: 'issue.changed', issueId: run.subjectId });
}
