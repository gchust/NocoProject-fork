/**
 * Trigger rules (protocol.md §2, iteration-1 contract §D). This is the only module that creates runs: every call to
 * `run.enqueue` is here.
 *
 * | Change                                                              | Result                                   |
 * | ------------------------------------------------------------------- | ---------------------------------------- |
 * | Human sets the executor to an agent, status not dormant             | enqueue, scope null, `assign` (`proposalAccepted` when a proposal is accepted) |
 * | Human moves the issue out of backlog to a non-terminal status       | enqueue for the agent executor, `statusChange` |
 * | ... either of the above with `start: false`                         | nothing (fields change only)             |
 * | Agent creates a sub-issue executed by an agent (self or delegated)  | enqueue on behalf of the owner, `assign` |
 * | Human comment mentioning agents                                     | one enqueue per agent, scope = thread root, `mention` |
 * | Human reply (no mention) to an agent's comment                      | that agent, scope = thread root, `reply` |
 * | Human top-level comment (no mention)                                | unique current input-capable run in the same authorization context, otherwise executor |
 * | Comment starting with `/note`, or agent-authored comment            | nothing                                  |
 * | Any of the above while the issue is blocked (`subtask/blocking.ts`) | nothing; activity `run_deferred_blocked` |
 * | An issue reaches a terminal status                                  | release dependents / next-stage siblings (`trigger/release.ts`) |
 * | Run failed with a retryable reason, attempts left                   | new run if still authorized, `retryOfRunId`, `retry` |
 * | A new `blockedBy` dependency leaves the issue blocked               | its queued / deferred runs are withdrawn (cancelled, `blocked`); activity `run_deferred_blocked` |
 * | Design approved; issue enters done (iteration 4)                    | `designApproved` / `retrospective` (`trigger/retrospective.ts`) |
 * | Any status write enters a status with stage actions (Phase 2)       | `stageEntered` and the other effects (`workflow/stage-actions.ts`) |
 * | A source reports a signal and its rule is on (Phase 2 signals)      | `signal` for the executor, on behalf of the owner (`trigger/signal.ts`) |
 * | A comment the project manager wrote in a member's name (`via = 'pm'`) | nothing (NP-183)                       |
 * | A conversation switches agent; a plan card finishes (NP-183)        | see `trigger/pm.ts`                      |
 *
 * Owner changes withdraw queued/deferred work of an executor the new owner cannot invoke; dispatched/running work finishes.
 * Implicit invocations check the invoking user's agent access; unauthorized triggers leave the comment intact.
 *
 * Comment triggers join an input-capable current run before pending-run coalescing. Other triggers and legacy
 * daemons retain queued delivery. Coalescing into an existing pending run, and "a running run makes the new one
 * wait", are enforced by `run.enqueue` and the claim SQL.
 */
import { forbid } from '../shared/authz.js';
import {
  canTriggerAgent,
  withdrawOnOwnerChange,
  canRetryAfterHandoff,
} from './access.js';
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import type { Tx } from '../shared/db.js';
import { fromJson, str } from '../shared/db.js';
import type {
  Comment,
  CommentPmFields,
  FailureReason,
  Issue,
  IssueV1,
  Phase1RunTriggerType,
  Run,
  TriggeredRun,
} from '../shared/protocol.js';
import { parseMentions, isNote } from '../collaboration/mentions.js';
import { runPriorityOf } from '../issue/issue.records.js';
import { mapRun } from '../run/run.records.js';
import type {
  EnqueueResult,
  RunService,
  TriggerRecordInput,
} from '../run/run.service.js';
import { blockersOf } from '../subtask/blocking.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { SettingsService } from '../system/settings.service.js';
import type { IdSource } from '../shared/ids.js';
import type { UserDirectory } from '../shared/users.js';
import { onStageEntered } from '../workflow/stage-actions.js';
import {
  onConversationRebound,
  onPlanFinished,
  type ConversationRebound,
  type PlanFinished,
} from './pm.js';
import { recordRunAttempt } from './preview.js';
import { onTerminalEntered, releaseIfUnblocked } from './release.js';
import { designApprovedRun, retrospectiveRun } from './retrospective.js';
import {
  onSignal,
  onSignalResolved,
  type SignalReport,
  type SignalResolution,
} from './signal.js';

export interface IssueChange {
  readonly before: IssueV1 | null;
  readonly after: IssueV1;
  readonly actor: Actor;
  /** false = do not start yet: the change must not enqueue `assign` / `statusChange` (default true). */
  readonly start?: boolean;
  /** The trigger type an executor change records (default `assign`). */
  readonly assignTriggerType?: 'assign' | 'proposalAccepted';
  /** For agent-created sub-issues: the user the run acts for (the owner). */
  readonly onBehalfOfUserId?: string | null;
}

export interface CommentChange {
  readonly comment: Comment & CommentPmFields;
  readonly issue: IssueV1;
  /** The direct parent comment, when this is a reply. */
  readonly parent: Comment | null;
  readonly actor: Actor;
}

export interface StatusChange {
  readonly before: IssueV1;
  readonly after: IssueV1;
  readonly actor: Actor;
}

export interface TriggerService {
  /** A human created or updated an issue (creation passes `before: null`), or an agent created a sub-issue. */
  onIssueChanged(tx: Tx, change: IssueChange): Promise<TriggeredRun[]>;
  onCommentCreated(tx: Tx, change: CommentChange): Promise<TriggeredRun[]>;
  /** Any status write (human, agent or system): terminal entry releases dependents and may wake the parent. */
  onStatusChanged(tx: Tx, change: StatusChange): Promise<TriggeredRun[]>;
  /** A dependency was removed: start the issue if nothing blocks it any more. */
  onUnblockCandidate(
    tx: Tx,
    issue: IssueV1,
    releasedBy: string,
  ): Promise<TriggeredRun[]>;
  /** Automatic retry of a failed run (called by the failure handler). */
  retryFailedRun(
    tx: Tx,
    failed: Run,
    maxAttempts: number,
    reason: FailureReason,
  ): Promise<EnqueueResult | null>;
  /** Manual retry from the browser. */
  manualRetry(tx: Tx, run: Run, actor: Actor): Promise<EnqueueResult>;
  /** A blocking dependency was added: withdraw the issue's queued runs if it is now blocked. Returns their ids. */
  onBlockingAdded(tx: Tx, issue: IssueV1): Promise<string[]>;
  /** Iteration 4: a member approved the design; `commentId` is the approval comment, if any. */
  onDesignApproved(
    tx: Tx,
    issue: IssueV1,
    actor: Actor,
    commentId: string | null,
  ): Promise<TriggeredRun[]>;
  /** Phase 2 signals: a source reports that the issue's linked object needs its executor (`trigger/signal.ts`). */
  onSignal(tx: Tx, report: SignalReport): Promise<TriggeredRun | null>;
  /** ...and that the problem is gone: the streak of that kind ends. */
  onSignalResolved(tx: Tx, resolution: SignalResolution): Promise<void>;
  /** NP-183: a project manager conversation switched agent (`trigger/pm.ts`). */
  onConversationRebound(
    tx: Tx,
    change: ConversationRebound,
  ): Promise<TriggeredRun[]>;
  /** NP-183: a plan card finished executing; wakes the conversation's agent (`trigger/pm.ts`). */
  onPlanFinished(tx: Tx, finished: PlanFinished): Promise<TriggeredRun | null>;
}

export interface TriggerDeps {
  readonly runs: () => RunService;
  readonly workflows: WorkflowService;
  readonly activity: ActivityRecorder;
  /** Iteration 4: `retrospectiveOnDone`, `pmAgentId`; Phase 2: the stage run loop guard. */
  readonly settings: SettingsService;
  /** Phase 2: the stage effects (checklist rows, workflow suggestions, executor names). */
  readonly ids: IdSource;
  readonly users: UserDirectory;
}

export interface EnqueueTarget {
  readonly issue: Issue;
  /** Recorded on the run and as the trigger's creator; null for system-initiated triggers. */
  readonly actorUserId: string | null;
  readonly agentId: string;
  readonly threadScope: string | null;
}

/**
 * Enqueues one run unless the caller cannot invoke the agent or the issue is blocked. A blocked issue gets an activity naming
 * the blockers instead of a run; the trigger is not stored (release re-triggers it as `dependencyReleased`).
 */
export async function enqueueFor(
  deps: TriggerDeps,
  tx: Tx,
  target: EnqueueTarget,
  trigger: TriggerRecordInput,
): Promise<TriggeredRun | null> {
  const { issue, agentId, threadScope, actorUserId } = target;
  const attempt = { agentId, issueId: issue.id, triggerType: trigger.type };
  if (!(await canTriggerAgent(tx, actorUserId, agentId))) {
    recordRunAttempt({ ...attempt, started: false, skipped: 'denied' });
    return null;
  }
  const blockers = await blockersOf(tx.conn, deps.workflows, issue as IssueV1);
  if (blockers.length > 0) {
    recordRunAttempt({ ...attempt, started: false, skipped: 'blocked' });
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor: { type: 'system', id: null },
      action: 'run_deferred_blocked',
      details: {
        agentId,
        triggerType: trigger.type,
        blockers: blockers.map((item) => ({
          issueId: item.issueId,
          identifier: item.identifier,
          reason: item.reason,
        })),
      },
    });
    tx.emit({ type: 'issue.changed', issueId: issue.id });
    return null;
  }
  const result = await deps.runs().enqueue(tx, {
    subjectId: issue.id,
    actorUserId,
    ownerUserId: issue.ownerUserId,
    priority: runPriorityOf(issue.priority),
    agentId,
    threadScope,
    triggers: [{ ...trigger, createdById: trigger.createdById ?? actorUserId }],
    appendInput: Boolean(trigger.commentId && trigger.payload?.input),
  });
  recordRunAttempt({ ...attempt, started: true });
  return { agentId, runId: result.runId };
}

async function onIssueChanged(
  deps: TriggerDeps,
  tx: Tx,
  change: IssueChange,
): Promise<TriggeredRun[]> {
  const { before, after, actor } = change;
  await withdrawOnOwnerChange(deps, tx, change);
  const actorUserId =
    actor.type === 'user' ? actor.id : (change.onBehalfOfUserId ?? null);
  if (actor.type !== 'user' && !change.onBehalfOfUserId) return [];
  if (change.start === false) return [];
  if (after.executorType !== 'agent' || !after.executorId) return [];
  const view = await deps.workflows.forIssue(tx.conn, after);
  const executorChanged =
    !before ||
    before.executorType !== 'agent' ||
    before.executorId !== after.executorId;
  let type: Phase1RunTriggerType | null = null;
  if (executorChanged && !view.isDormant(after.statusKey)) {
    type = change.assignTriggerType ?? 'assign';
  } else if (
    before &&
    before.statusKey === 'backlog' &&
    after.statusKey !== 'backlog' &&
    !view.isTerminal(after.statusKey)
  ) {
    type = 'statusChange';
  }
  if (!type) return [];
  const triggered = await enqueueFor(
    deps,
    tx,
    { issue: after, actorUserId, agentId: after.executorId, threadScope: null },
    {
      type,
      payload:
        type === 'statusChange'
          ? { from: before?.statusKey ?? null, to: after.statusKey }
          : actor.type === 'agent'
            ? { createdByAgentId: actor.id, sourceRunId: actor.runId ?? null }
            : null,
    },
  );
  return triggered ? [triggered] : [];
}

async function onCommentCreated(
  deps: TriggerDeps,
  tx: Tx,
  { comment, issue, parent, actor }: CommentChange,
): Promise<TriggeredRun[]> {
  // Agent-authored (and system) comments never trigger; mentions in them are plain text. So are the comments the
  // project manager writes in a member's name (NP-183, `via = 'pm'`): an agent's output never starts a run.
  if (actor.type !== 'user' || comment.authorType !== 'user') return [];
  if (actor.via === 'pm') return [];
  if (isNote(comment.content)) return [];
  const route = (
    agentId: string,
    threadScope: string | null,
    type: 'mention' | 'reply' | 'comment',
  ) =>
    enqueueFor(
      deps,
      tx,
      { issue, actorUserId: actor.id, agentId, threadScope },
      {
        type,
        commentId: comment.id,
        payload: {
          input: {
            id: comment.id,
            authorName: comment.authorName,
            content: comment.content,
            parentId: comment.parentId,
            rootId: comment.rootId,
            ...(comment.context ? { context: comment.context } : {}),
          },
        },
      },
    );

  const mentioned = parseMentions(comment.content);
  if (mentioned.length > 0) {
    const results: TriggeredRun[] = [];
    for (const agentId of mentioned) {
      const triggered = await route(agentId, comment.rootId, 'mention');
      if (triggered) results.push(triggered);
    }
    return results;
  }
  let triggered: TriggeredRun | null = null;
  if (parent) {
    if (parent.authorType === 'agent' && parent.authorId) {
      triggered = await route(parent.authorId, comment.rootId, 'reply');
    }
  } else {
    const current = await deps.runs().currentInputRun(tx, issue.id, actor.id);
    const agentId =
      current?.agentId ??
      (issue.executorType === 'agent' ? issue.executorId : null);
    if (agentId)
      triggered = await route(agentId, current?.threadScope ?? null, 'comment');
  }
  return triggered ? [triggered] : [];
}

async function retryFailedRun(
  deps: TriggerDeps,
  tx: Tx,
  failed: Run,
  maxAttempts: number,
  reason: FailureReason,
): Promise<EnqueueResult | null> {
  if (failed.attempt >= maxAttempts) return null;
  if (!(await canTriggerAgent(tx, failed.actorUserId, failed.agentId)))
    return null;
  if (!(await canRetryAfterHandoff(tx, failed))) return null;
  // Carry the original triggers so the retry sees the same comments, then mark it as a retry.
  const original = await tx.conn.query
    .selectFrom('runTriggers')
    .select(['type', 'commentId', 'payload', 'createdById'])
    .where('runId', '=', failed.id)
    .orderBy('createdAt', 'asc')
    .execute();
  const carried: TriggerRecordInput[] = original
    .filter((row) => row.type !== 'retry')
    .map((row) => ({
      type: str(row.type) as TriggerRecordInput['type'],
      commentId: str(row.commentId),
      payload: fromJson<Record<string, unknown>>(row.payload),
      createdById: str(row.createdById),
    }));
  return deps.runs().enqueue(tx, {
    agentId: failed.agentId,
    subjectId: failed.subjectId,
    threadScope: failed.threadScope,
    actorUserId: failed.actorUserId,
    ownerUserId: failed.ownerUserId,
    priority: failed.priority,
    attempt: failed.attempt + 1,
    maxAttempts,
    retryOfRunId: failed.id,
    triggers: [
      ...carried,
      { type: 'retry', payload: { retryOfRunId: failed.id, reason } },
    ],
  });
}

async function manualRetry(
  deps: TriggerDeps,
  tx: Tx,
  run: Run,
  actor: Actor,
): Promise<EnqueueResult> {
  const userId = actor.type === 'user' ? actor.id : null;
  if (!(await canTriggerAgent(tx, userId, run.agentId)))
    forbid('You do not have access to this agent.');
  return deps.runs().enqueue(tx, {
    agentId: run.agentId,
    subjectId: run.subjectId,
    threadScope: run.threadScope,
    actorUserId: userId ?? run.actorUserId,
    ownerUserId: run.ownerUserId,
    priority: run.priority,
    retryOfRunId: run.id,
    triggers: [
      {
        type: 'retry',
        payload: { retryOfRunId: run.id, manual: true },
        createdById: userId,
      },
    ],
  });
}

async function onBlockingAdded(
  deps: TriggerDeps,
  tx: Tx,
  issue: IssueV1,
): Promise<string[]> {
  const blockers = await blockersOf(tx.conn, deps.workflows, issue);
  if (blockers.length === 0) return [];
  const rows = await tx.conn.query
    .selectFrom('runs')
    .selectAll()
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', issue.id)
    .where('status', 'in', ['queued', 'deferred'])
    .execute();
  const withdrawn: string[] = [];
  for (const run of rows.map(mapRun)) {
    if (!(await deps.runs().withdrawQueued(tx, run))) continue;
    withdrawn.push(run.id);
    const first = await tx.conn.query
      .selectFrom('runTriggers')
      .select('type')
      .where('runId', '=', run.id)
      .orderBy('createdAt', 'asc')
      .executeTakeFirst();
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor: { type: 'system', id: null },
      action: 'run_deferred_blocked',
      details: {
        agentId: run.agentId,
        runId: run.id,
        withdrawn: true,
        triggerType: first ? str(first.type) : null,
        blockers: blockers.map((item) => ({
          issueId: item.issueId,
          identifier: item.identifier,
          reason: item.reason,
        })),
      },
    });
  }
  return withdrawn;
}

export function createTriggerService(deps: TriggerDeps): TriggerService {
  const enqueue = (
    tx: Tx,
    target: EnqueueTarget,
    trigger: TriggerRecordInput,
  ) => enqueueFor(deps, tx, target, trigger);
  return {
    onIssueChanged: (tx, change) => onIssueChanged(deps, tx, change),
    onCommentCreated: (tx, change) => onCommentCreated(deps, tx, change),
    async onStatusChanged(tx, change) {
      const { before, after } = change;
      if (before.statusKey === after.statusKey) return [];
      const view = await deps.workflows.forIssue(tx.conn, after);
      const staged = await onStageEntered({ ...deps, enqueue }, tx, {
        ...change,
        view,
      });
      if (
        !view.isTerminal(after.statusKey) ||
        view.isTerminal(before.statusKey)
      )
        return staged;
      return [
        ...staged,
        ...(await onTerminalEntered({ ...deps, enqueue }, tx, after)),
        ...(await retrospectiveRun({ ...deps, enqueue }, tx, change)),
      ];
    },
    onUnblockCandidate: (tx, issue, releasedBy) =>
      releaseIfUnblocked({ ...deps, enqueue }, tx, issue, releasedBy),
    retryFailedRun: (tx, failed, maxAttempts, reason) =>
      retryFailedRun(deps, tx, failed, maxAttempts, reason),
    manualRetry: (tx, run, actor) => manualRetry(deps, tx, run, actor),
    onBlockingAdded: (tx, issue) => onBlockingAdded(deps, tx, issue),
    onDesignApproved: (tx, issue, actor, commentId) =>
      designApprovedRun({ ...deps, enqueue }, tx, issue, actor, commentId),
    onSignal: (tx, report) => onSignal({ ...deps, enqueue }, tx, report),
    onSignalResolved: (tx, resolution) =>
      onSignalResolved(deps, tx, resolution),
    onConversationRebound: (tx, change) =>
      onConversationRebound({ ...deps, enqueue }, tx, change),
    onPlanFinished: (tx, finished) =>
      onPlanFinished({ ...deps, enqueue }, tx, finished),
  };
}
