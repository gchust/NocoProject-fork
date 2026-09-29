import { hasCapability } from '../agent/capabilities.js';
/**
 * Iteration 4 trigger rules (docs/phase1/iteration-4-contract.md §B, §C). Part of the trigger module: only
 * `trigger.service.ts` hands this file its enqueue functions.
 *
 * | Change                                                       | Result                                                    |
 * | ------------------------------------------------------------ | --------------------------------------------------------- |
 * | A member approves the design of an issue an agent executes   | enqueue for the executor, scope null, `designApproved` (carrying the approval comment) |
 * | An issue enters a done status, `settings.retrospectiveOnDone` and `settings.pmAgentId` are set, and an agent executes or executed it | enqueue for the project manager, scope `retro`, `retrospective`, acting for the member who closed it (the owner when the system did) |
 *
 * No retrospective for a project manager conversation (`originType = 'pm'`), for an issue the project manager
 * itself executes, when the configured agent is archived or not a manager, or when it re-enters done from another
 * done status.
 */
import type { Actor } from '../shared/activity.js';
import type { Tx } from '../shared/db.js';
import type { IssueV1, IssueV4, TriggeredRun } from '../shared/protocol.js';
import { RETROSPECTIVE_THREAD_SCOPE } from '../shared/protocol.js';
import { runPriorityOf } from '../issue/issue.records.js';
import type { RunService, TriggerRecordInput } from '../run/run.service.js';
import type { SettingsService } from '../system/settings.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { EnqueueTarget } from './trigger.service.js';

export interface Iteration4TriggerDeps {
  readonly runs: () => RunService;
  readonly workflows: WorkflowService;
  readonly settings: SettingsService;
  readonly enqueue: (
    tx: Tx,
    target: EnqueueTarget,
    trigger: TriggerRecordInput,
  ) => Promise<TriggeredRun | null>;
}

/** The implementation run after a design approval. */
export async function designApprovedRun(
  deps: Iteration4TriggerDeps,
  tx: Tx,
  issue: IssueV1,
  actor: Actor,
  commentId: string | null,
): Promise<TriggeredRun[]> {
  if (issue.executorType !== 'agent' || !issue.executorId) return [];
  const actorUserId = actor.type === 'user' ? actor.id : issue.ownerUserId;
  const triggered = await deps.enqueue(
    tx,
    { issue, actorUserId, agentId: issue.executorId, threadScope: null },
    {
      type: 'designApproved',
      commentId,
      payload: { approvedById: actorUserId },
    },
  );
  return triggered ? [triggered] : [];
}

/** The configured project manager, when it exists, is active and is a manager. */
async function activeManager(tx: Tx, agentId: string): Promise<boolean> {
  const row = await tx.conn.query
    .selectFrom('agents')
    .select(['kind', 'archivedAt'])
    .where('id', '=', agentId)
    .executeTakeFirst();
  return (
    !!row &&
    !row.archivedAt &&
    (await hasCapability(tx.conn, agentId, 'comment.create'))
  );
}

/** The issue is executed by an agent other than the manager, or one ran on it. */
async function workedByAgent(
  tx: Tx,
  issue: IssueV4,
  managerId: string,
): Promise<boolean> {
  if (issue.executorType === 'agent' && issue.executorId)
    return issue.executorId !== managerId;
  return tx.conn.query
    .selectFrom('runs')
    .select('id')
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', issue.id)
    .where('agentId', '!=', managerId)
    .exists();
}

/** The retrospective run when an issue enters done (see the file comment). */
export async function retrospectiveRun(
  deps: Iteration4TriggerDeps,
  tx: Tx,
  change: {
    readonly before: IssueV1;
    readonly after: IssueV1;
    readonly actor: Actor;
  },
): Promise<TriggeredRun[]> {
  const issue = change.after as IssueV4;
  if (issue.originType === 'pm') return [];
  const view = await deps.workflows.forIssue(tx.conn, issue);
  if (!view.isDone(issue.statusKey) || view.isDone(change.before.statusKey))
    return [];
  const settings = await deps.settings.read(tx.conn);
  const managerId = settings.agentEntries.completion.agentId;
  if (!settings.agentEntries.completion.enabled || !managerId) return [];
  if (!(await activeManager(tx, managerId))) return [];
  if (!(await workedByAgent(tx, issue, managerId))) return [];
  const { actor } = change;
  const actorUserId = actor.type === 'user' ? actor.id : issue.ownerUserId;
  const result = await deps.runs().enqueue(tx, {
    agentId: managerId,
    subjectId: issue.id,
    threadScope: RETROSPECTIVE_THREAD_SCOPE,
    actorUserId,
    ownerUserId: issue.ownerUserId,
    priority: runPriorityOf(issue.priority),
    triggers: [
      {
        type: 'retrospective',
        payload: {
          from: change.before.statusKey,
          to: issue.statusKey,
          doneBy: { type: actor.type, id: actor.id },
        },
        createdById: actorUserId,
      },
    ],
  });
  return [{ agentId: managerId, runId: result.runId }];
}
