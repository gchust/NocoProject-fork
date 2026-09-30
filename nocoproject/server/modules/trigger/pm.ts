/**
 * The project manager conversation's trigger rules (NP-183, protocol-pm-assistant.md §4.7, §6.5):
 *
 * | Change                                                    | Result                                                  |
 * | --------------------------------------------------------- | ------------------------------------------------------- |
 * | A conversation switches agent (fallback / restore / bound agent gone) | its queued / deferred runs of the old agent are withdrawn and their triggers enqueued for the new one; dispatched / running work finishes |
 * | A member's plan card finished executing (executed or failed) | the conversation's agent, on behalf of the executing member, `planExecuted` with the `plan_result` comment |
 *
 * Both go through `enqueueFor`, so the invocation and blocking rules apply as everywhere else.
 */
import type { Tx } from '../shared/db.js';
import { fromJson, str } from '../shared/db.js';
import type {
  IssueV1,
  PmPlanExecutedPayload,
  TriggeredRun,
} from '../shared/protocol.js';
import { mapRun } from '../run/run.records.js';
import type { TriggerRecordInput } from '../run/run.service.js';
import type { EnqueueTarget, TriggerDeps } from './trigger.service.js';

type Enqueue = (
  tx: Tx,
  target: EnqueueTarget,
  trigger: TriggerRecordInput,
) => Promise<TriggeredRun | null>;

export interface PmTriggerDeps extends TriggerDeps {
  readonly enqueue: Enqueue;
}

export interface ConversationRebound {
  /** The conversation issue, its executor already the new agent. */
  readonly issue: IssueV1;
  readonly fromAgentId: string | null;
}

/** Moves the conversation's not-yet-claimed work from the previous agent to the new executor. */
export async function onConversationRebound(
  deps: PmTriggerDeps,
  tx: Tx,
  { issue, fromAgentId }: ConversationRebound,
): Promise<TriggeredRun[]> {
  const toAgentId = issue.executorId;
  if (!fromAgentId || !toAgentId || fromAgentId === toAgentId) return [];
  const rows = await tx.conn.query
    .selectFrom('runs')
    .selectAll()
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', issue.id)
    .where('agentId', '=', fromAgentId)
    .where('status', 'in', ['queued', 'deferred'])
    .execute();
  const moved: TriggeredRun[] = [];
  for (const run of rows.map(mapRun)) {
    if (!(await deps.runs().withdrawQueued(tx, run, 'cancelled'))) continue;
    const triggers = await tx.conn.query
      .selectFrom('runTriggers')
      .select(['type', 'commentId', 'payload', 'createdById'])
      .where('runId', '=', run.id)
      .orderBy('createdAt', 'asc')
      .execute();
    for (const row of triggers) {
      const triggered = await deps.enqueue(
        tx,
        {
          issue: issue as never,
          actorUserId: run.actorUserId,
          agentId: toAgentId,
          threadScope: run.threadScope,
        },
        {
          type: str(row.type) as TriggerRecordInput['type'],
          commentId: str(row.commentId),
          payload: fromJson<Record<string, unknown>>(row.payload),
          createdById: str(row.createdById),
        },
      );
      if (triggered && !moved.some((item) => item.runId === triggered.runId))
        moved.push(triggered);
    }
  }
  return moved;
}

export interface PlanFinished {
  readonly conversation: IssueV1;
  /** The member who executed the plan (its owner). */
  readonly actorUserId: string;
  readonly payload: PmPlanExecutedPayload;
  /** The `plan_result` comment. */
  readonly commentId: string;
}

/** Wakes the conversation's agent with the plan's result. */
export async function onPlanFinished(
  deps: PmTriggerDeps,
  tx: Tx,
  finished: PlanFinished,
): Promise<TriggeredRun | null> {
  const { conversation } = finished;
  if (conversation.executorType !== 'agent' || !conversation.executorId)
    return null;
  return deps.enqueue(
    tx,
    {
      issue: conversation as never,
      actorUserId: finished.actorUserId,
      agentId: conversation.executorId,
      threadScope: null,
    },
    {
      type: 'planExecuted',
      commentId: finished.commentId,
      payload: { ...finished.payload },
    },
  );
}
