/**
 * What happens when an issue reaches a terminal status (iteration-1 contract §D):
 *
 * 1. Release: every issue that depends on it (`blockedBy`) and every later-stage sibling that is no longer blocked
 *    starts — `dependencyReleased` for an agent executor in `todo` (acting for that issue's owner), or an info inbox
 *    item `dependency_released` for the owner when there is no executor.
 * 2. Batch done: when every child in its batch (same stage; all children when it has no stage) is terminal, the
 *    parent's owner gets `batch_done`, and a non-dormant parent executed by an agent is woken with `childBatchDone`
 *    if the workflow says so. Coalescing into a pending parent run is `run.enqueue`'s usual rule.
 *
 * Part of the trigger module: only `trigger.service.ts` hands this file its enqueue function.
 */
import type { Tx } from '../shared/db.js';
import { str, unique } from '../shared/db.js';
import type { IssueV1, TriggeredRun } from '../shared/protocol.js';
import { findIssue, issuesByIds } from '../issue/issue.records.js';
import type { TriggerRecordInput } from '../run/run.service.js';
import { blockersOf, childrenOf } from '../subtask/blocking.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { EnqueueTarget } from './trigger.service.js';

export interface ReleaseDeps {
  readonly workflows: WorkflowService;
  readonly enqueue: (
    tx: Tx,
    target: EnqueueTarget,
    trigger: TriggerRecordInput,
  ) => Promise<TriggeredRun | null>;
}

/** Starts `issue` if nothing blocks it any more (see the file comment for what "start" means). */
export async function releaseIfUnblocked(
  deps: ReleaseDeps,
  tx: Tx,
  issue: IssueV1,
  releasedBy: string,
): Promise<TriggeredRun[]> {
  const view = await deps.workflows.forIssue(tx.conn, issue);
  if (view.isTerminal(issue.statusKey)) return [];
  if ((await blockersOf(tx.conn, deps.workflows, issue)).length > 0) return [];
  if (issue.executorType === 'agent' && issue.executorId) {
    if (issue.statusKey !== 'todo') return [];
    const triggered = await deps.enqueue(
      tx,
      {
        issue,
        actorUserId: issue.ownerUserId,
        agentId: issue.executorId,
        threadScope: null,
      },
      {
        type: 'dependencyReleased',
        payload: { releasedBy },
        createdById: null,
      },
    );
    return triggered ? [triggered] : [];
  }
  if (issue.executorType === 'none')
    tx.emit({
      type: 'issue.dependencyReleased',
      issueId: issue.id,
      releasedBy,
    });
  return [];
}

async function releaseCandidates(tx: Tx, issue: IssueV1): Promise<IssueV1[]> {
  const dependents = await tx.conn.query
    .selectFrom('issueDependencies')
    .select('issueId')
    .where('dependsOnIssueId', '=', issue.id)
    .where('type', '=', 'blockedBy')
    .execute();
  const byId = await issuesByIds(
    tx.conn,
    dependents.map((row) => str(row.issueId)),
  );
  if (issue.parentIssueId && issue.stage !== null) {
    const later = await tx.conn.query
      .selectFrom('issues')
      .select('id')
      .where('parentIssueId', '=', issue.parentIssueId)
      .where('stage', '>', issue.stage)
      .where('deletedAt', 'is', null)
      .execute();
    const siblings = await issuesByIds(
      tx.conn,
      later.map((row) => str(row.id)),
    );
    for (const [id, sibling] of siblings) byId.set(id, sibling);
  }
  byId.delete(issue.id);
  return Array.from(byId.values()).sort((a, b) => a.number - b.number);
}

async function batchDone(
  deps: ReleaseDeps,
  tx: Tx,
  issue: IssueV1,
): Promise<TriggeredRun[]> {
  if (!issue.parentIssueId) return [];
  const children = await childrenOf(tx.conn, issue.parentIssueId);
  const batch =
    issue.stage === null
      ? children
      : children.filter((child) => child.stage === issue.stage);
  for (const child of batch) {
    const view = await deps.workflows.forIssue(tx.conn, child);
    if (!view.isTerminal(child.statusKey)) return [];
  }
  const childIssueIds = unique(batch.map((child) => child.id));
  tx.emit({
    type: 'issue.batchDone',
    parentIssueId: issue.parentIssueId,
    stage: issue.stage,
    childIssueIds,
  });
  const parent = await findIssue(tx.conn, issue.parentIssueId);
  if (!parent || parent.executorType !== 'agent' || !parent.executorId)
    return [];
  const view = await deps.workflows.forIssue(tx.conn, parent);
  if (
    view.isDormant(parent.statusKey) ||
    !view.workflow.definition.childBatchDoneWakesParentExecutor
  )
    return [];
  const triggered = await deps.enqueue(
    tx,
    {
      issue: parent,
      actorUserId: parent.ownerUserId,
      agentId: parent.executorId,
      threadScope: null,
    },
    {
      type: 'childBatchDone',
      payload: { stage: issue.stage, childIssueIds },
      createdById: null,
    },
  );
  return triggered ? [triggered] : [];
}

export async function onTerminalEntered(
  deps: ReleaseDeps,
  tx: Tx,
  issue: IssueV1,
): Promise<TriggeredRun[]> {
  const results: TriggeredRun[] = [];
  for (const candidate of await releaseCandidates(tx, issue)) {
    results.push(...(await releaseIfUnblocked(deps, tx, candidate, issue.id)));
  }
  results.push(...(await batchDone(deps, tx, issue)));
  return results;
}
