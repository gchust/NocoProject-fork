/**
 * Status writes that are not a plain field edit: agent transitions, the approval gate, the transition an approver
 * accepts, system writes (a merged pull request, a failed run's reset).
 *
 * Every status change goes through `writeStatus`: one revision, a `status_changed` activity, the trigger rules for
 * terminal entry, and the `issue.updated` event. Human and agent writes call the approval gate (`shared/approval.ts`)
 * first; system writes and approved transitions do not. Iteration 4: agent writes also pass the design gate
 * (`process.ts`).
 *
 * Phase 2 (NP-77 §2): human and agent writes go through `transitionPipeline` — canTransition → design gate (agents) →
 * entry conditions (`workflow/stage-guards.ts`) → approval gate — and then `writeStatus`, whose trigger call runs the
 * stage effects. An approved transition checks the entry conditions again; when they no longer hold it is not applied
 * and the gateway cancels the request as stale.
 */
import type { Actor } from '../shared/activity.js';
import { SYSTEM_ACTOR } from '../shared/activity.js';
import type { Tx } from '../shared/db.js';
import { now } from '../shared/db.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import type { ApprovalApplyResult } from '../shared/approval.js';
import type {
  ApprovalRequest,
  IssueV4,
  TransitionActor,
} from '../shared/protocol.js';
import {
  assertStageGuards,
  stageGuardFailure,
} from '../workflow/stage-guards.js';
import { ACTIVE_STATUSES } from '../run/run.records.js';
import { validateStatus } from './issue.fields.js';
import { emitUpdate } from './issue.events.js';
import { findIssue, mapIssue } from './issue.records.js';
import type { IssueDeps } from './issue.service.js';
import { agentProcessGate } from './process.js';
import type { WorkflowView } from './status.js';

/** The outcome of a status write that may be held for approval. */
export interface IssueStatusResult {
  /** The issue after the write, or unchanged when the transition waits for approval. */
  readonly issue: IssueV4;
  readonly pendingApproval: ApprovalRequest | null;
}

function transitionActor(actor: Actor): TransitionActor {
  return actor.type === 'user' || actor.type === 'agent'
    ? actor.type
    : 'system';
}

/** Writes `target` (one revision), records the activity and runs the terminal-entry trigger rules. */
export async function writeStatus(
  deps: IssueDeps,
  tx: Tx,
  before: IssueV4,
  target: string,
  actor: Actor,
  details: Readonly<Record<string, unknown>> = {},
): Promise<IssueV4> {
  const timestamp = now();
  await tx.conn.query
    .updateTable('issues')
    .set({
      statusKey: target,
      revision: before.revision + 1,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    })
    .where('id', '=', before.id)
    .execute();
  await deps.activity.record(tx.conn, {
    issueId: before.id,
    actor,
    action: 'status_changed',
    details: { from: before.statusKey, to: target, ...details },
  });
  const after = (await findIssue(tx.conn, before.id)) as IssueV4;
  await deps.triggers().onStatusChanged(tx, { before, after, actor });
  emitUpdate(tx, before, after, actor);
  // Stage effects may have written the issue again (a preset executor): answer its current revision.
  return (await findIssue(tx.conn, before.id)) ?? after;
}

/**
 * Asks the approval gate about `issue.statusKey → target`. Returns the pending request when the transition has to
 * wait, or null when it may be applied now.
 */
export async function gateTransition(
  deps: IssueDeps,
  tx: Tx,
  issue: IssueV4,
  target: string,
  actor: Actor,
  view: WorkflowView,
): Promise<ApprovalRequest | null> {
  const result = await deps.approvals().gate(
    {
      issue,
      fromStatus: issue.statusKey,
      toStatus: target,
      actor,
      approval: view.approvalFor(
        issue.statusKey,
        target,
        transitionActor(actor),
      ),
    },
    tx,
  );
  return result.kind === 'pending' ? result.request : null;
}

/**
 * The checks before a human or agent status write, in order: the agent transition and design gate (a human's
 * transition and terminal rule are checked with the other fields, `issue.fields.ts`), the entry conditions, then the
 * approval gate. Returns the pending request when the transition has to wait, or null when it may be written now.
 */
export async function transitionPipeline(
  deps: IssueDeps,
  tx: Tx,
  input: {
    readonly before: IssueV4;
    readonly target: string;
    readonly actor: Actor;
    readonly view: WorkflowView;
  },
): Promise<ApprovalRequest | null> {
  const { before, target, actor, view } = input;
  if (actor.type === 'agent') {
    if (!view.canTransition(before.statusKey, target, 'agent'))
      throw forbidden(
        'TRANSITION_NOT_ALLOWED',
        `Agents may not move an issue from ${before.statusKey} to ${target}.`,
      );
    await agentProcessGate(tx.conn, before, target);
  }
  await assertStageGuards(tx.conn, view, before, target, actor);
  return gateTransition(deps, tx, before, target, actor, view);
}

/** An agent (run token) moving its issue along the workflow's agent transitions. Never enqueues for itself. */
export async function agentSetStatus(
  deps: IssueDeps,
  actor: Actor,
  idOrKey: string,
  statusKey: string,
): Promise<IssueStatusResult> {
  return deps.tx.run(async (tx) => {
    const before = await findIssue(tx.conn, idOrKey);
    if (!before) throw notFound('Issue');
    const view = await deps.workflows.forIssue(tx.conn, before);
    const target = validateStatus(view, statusKey);
    if (before.statusKey === target)
      return { issue: before, pendingApproval: null };
    const pending = await transitionPipeline(deps, tx, {
      before,
      target,
      actor,
      view,
    });
    if (pending) return { issue: before, pendingApproval: pending };
    return {
      issue: await writeStatus(deps, tx, before, target, actor),
      pendingApproval: null,
    };
  });
}

/**
 * A system write (a merged pull request): not gated and not limited by the agent transitions. Returns null when the
 * issue is gone, already there, or the target is not in its workflow.
 */
export async function systemSetStatus(
  deps: IssueDeps,
  tx: Tx,
  issueId: string,
  target: string,
  details: Readonly<Record<string, unknown>>,
): Promise<IssueV4 | null> {
  const before = await findIssue(tx.conn, issueId);
  if (!before || before.statusKey === target) return null;
  const view = await deps.workflows.forIssue(tx.conn, before);
  if (!view.isKnown(target)) return null;
  return writeStatus(deps, tx, before, target, SYSTEM_ACTOR, details);
}

/**
 * The transition an approver accepted, applied on their behalf (the status activity names the approver). Not applied
 * when its entry conditions no longer hold (the gateway then cancels the request as stale).
 */
export async function applyApprovedTransition(
  deps: IssueDeps,
  tx: Tx,
  request: ApprovalRequest,
  approver: Actor,
): Promise<ApprovalApplyResult> {
  const before = await findIssue(tx.conn, request.issueId);
  if (!before) throw notFound('Issue');
  if (before.statusKey !== request.fromStatus)
    throw conflict(
      'APPROVAL_STALE',
      `The issue is now ${before.statusKey}; the request was for ${request.fromStatus}.`,
    );
  const view = await deps.workflows.forIssue(tx.conn, before);
  validateStatus(view, request.toStatus);
  const failure = await stageGuardFailure(
    tx.conn,
    view,
    before,
    request.toStatus,
    approver,
  );
  if (failure)
    return { applied: false, code: failure.code, message: failure.message };
  const after = await writeStatus(
    deps,
    tx,
    before,
    request.toStatus,
    approver,
    {
      approvalRequestId: request.id,
    },
  );
  await deps.triggers().onIssueChanged(tx, { before, after, actor: approver });
  return { applied: true };
}

/** in_progress → todo when a run failed and nothing else is active on the issue. */
export async function resetAbandonedIssue(
  deps: IssueDeps,
  tx: Tx,
  issueId: string,
): Promise<boolean> {
  const row = await tx.conn.query
    .selectFrom('issues')
    .selectAll()
    .where('id', '=', issueId)
    .executeTakeFirst();
  if (!row) return false;
  const issue = mapIssue(row);
  if (issue.statusKey !== 'in_progress') return false;
  const busy = await tx.conn.query
    .selectFrom('runs')
    .select('id')
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', issueId)
    .where('status', 'in', ACTIVE_STATUSES)
    .exists();
  if (busy) return false;
  const timestamp = now();
  await tx.conn.query
    .updateTable('issues')
    .set({
      statusKey: 'todo',
      revision: issue.revision + 1,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    })
    .where('id', '=', issueId)
    .where('statusKey', '=', 'in_progress')
    .execute();
  await deps.activity.record(tx.conn, {
    issueId,
    actor: SYSTEM_ACTOR,
    action: 'status_changed',
    details: { from: 'in_progress', to: 'todo', reason: 'runFailed' },
  });
  const after = (await findIssue(tx.conn, issueId)) as IssueV4;
  emitUpdate(tx, issue, after, SYSTEM_ACTOR);
  return true;
}
