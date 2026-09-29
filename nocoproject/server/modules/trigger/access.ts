/** Invocation checks and the queued-work boundary when an issue changes hands. */
import { canInvokeAgent, loadAgentAccess } from '../shared/authz.js';
import type { Tx } from '../shared/db.js';
import type { Run } from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';
import { mapRun } from '../run/run.records.js';
import type { IssueChange, TriggerDeps } from './trigger.service.js';

export async function canTriggerAgent(
  tx: Tx,
  userId: string | null,
  agentId: string,
): Promise<boolean> {
  if (!userId) return false;
  const agent = await loadAgentAccess(tx.conn, agentId);
  return !!agent && canInvokeAgent(tx.conn, userId, agent);
}

/** An already dispatched round may finish, but it must not restart after an unauthorized handoff. */
export async function canRetryAfterHandoff(tx: Tx, run: Run): Promise<boolean> {
  const issue = await findIssue(tx.conn, run.subjectId);
  if (!issue) return false;
  return (
    issue.ownerUserId === run.ownerUserId ||
    canTriggerAgent(tx, issue.ownerUserId, run.agentId)
  );
}

export async function withdrawOnOwnerChange(
  deps: TriggerDeps,
  tx: Tx,
  { before, after }: IssueChange,
): Promise<void> {
  if (
    !before ||
    before.ownerUserId === after.ownerUserId ||
    before.executorType !== 'agent' ||
    !before.executorId ||
    (await canTriggerAgent(tx, after.ownerUserId, before.executorId))
  )
    return;
  const rows = await tx.conn.query
    .selectFrom('runs')
    .selectAll()
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', after.id)
    .where('agentId', '=', before.executorId)
    .where('status', 'in', ['queued', 'deferred'])
    .execute();
  for (const run of rows.map(mapRun)) {
    // Conditional transition preserves a run already claimed concurrently by a daemon.
    await deps.runs().withdrawQueued(tx, run, 'cancelled');
  }
}
