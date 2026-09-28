/**
 * Deciding a delivery straight from the inbox (docs/phase1/iteration-3-contract.md §E), in one transaction:
 *
 * - accept: the done status through the normal PATCH path (field authorization, the approval gate — a pending
 *   approval leaves the status unchanged and the route answers 202), an optional acceptance comment that triggers no
 *   run, activity `delivery_accepted`.
 * - request changes: the status back to in_progress when the workflow has it and the issue is elsewhere (same path),
 *   then a top-level comment that runs the trigger rules (the executor agent's next turn), activity
 *   `changes_requested`.
 *
 * Both emit `delivery.decided`, which resolves the issue's `review_requested` cards (the notification module; a
 * status that leaves in_review would resolve them too).
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import { requireVisibleIssue, viewerOf } from '../shared/authz.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { conflict, invalid } from '../shared/errors.js';
import type {
  AcceptDeliveryRequest,
  CommentV2,
  DeliveryResultV3,
  IssueV4,
  RequestChangesRequest,
} from '../shared/protocol.js';
import type { CommentService } from '../collaboration/comment.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import { eventActor } from './issue.events.js';
import { findIssue } from './issue.records.js';
import type { IssueService, IssueStatusResult } from './issue.service.js';
import type { WorkflowView } from './status.js';

const MAX_COMMENT = 200_000;

export interface DeliveryService {
  accept(
    actor: Actor,
    idOrKey: string,
    input: AcceptDeliveryRequest,
  ): Promise<DeliveryResultV3>;
  requestChanges(
    actor: Actor,
    idOrKey: string,
    input: RequestChangesRequest,
  ): Promise<DeliveryResultV3>;
}

export interface DeliveryDeps {
  readonly tx: TxRunner;
  readonly activity: ActivityRecorder;
  readonly workflows: WorkflowService;
  readonly issues: () => IssueService;
  readonly comments: () => CommentService;
}

function commentText(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid('INVALID_COMMENT', 'comment is required.');
    return null;
  }
  if (typeof value !== 'string' || value.length > MAX_COMMENT)
    throw invalid('INVALID_COMMENT', 'comment must be text.');
  if (required && value.trim() === '')
    throw invalid('INVALID_COMMENT', 'comment is required.');
  return value.trim() === '' ? null : value;
}

/** `done`, or the first status of the done category. */
function doneStatus(view: WorkflowView): string {
  if (view.isKnown('done')) return 'done';
  const entry = view.catalog.find((status) => status.category === 'done');
  if (!entry)
    throw conflict(
      'NO_DONE_STATUS',
      "The issue's workflow has no done status.",
    );
  return entry.key;
}

async function moveTo(
  deps: DeliveryDeps,
  tx: Tx,
  actor: Actor,
  issue: IssueV4,
  target: string | null,
): Promise<IssueStatusResult> {
  if (!target || issue.statusKey === target)
    return { issue, pendingApproval: null };
  return deps
    .issues()
    .patch(
      actor,
      issue.id,
      { statusKey: target, revision: issue.revision },
      tx,
    );
}

interface Decision {
  readonly kind: 'accepted' | 'changesRequested';
  readonly comment: string | null;
  readonly target: (view: WorkflowView) => string | null;
  /** Whether the comment runs the trigger rules. */
  readonly trigger: boolean;
}

async function decide(
  deps: DeliveryDeps,
  actor: Actor,
  idOrKey: string,
  decision: Decision,
): Promise<DeliveryResultV3> {
  return deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    const issue = await requireVisibleIssue(tx.conn, viewer, idOrKey);
    const view = await deps.workflows.forIssue(tx.conn, issue);
    const moved = await moveTo(deps, tx, actor, issue, decision.target(view));
    let comment: CommentV2 | null = null;
    if (decision.comment) {
      const created = await deps
        .comments()
        .create(
          actor,
          issue.id,
          { content: decision.comment },
          { outer: tx, trigger: decision.trigger },
        );
      comment = created.comment as CommentV2;
    }
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action:
        decision.kind === 'accepted'
          ? 'delivery_accepted'
          : 'changes_requested',
      details: {
        from: issue.statusKey,
        to: moved.issue.statusKey,
        commentId: comment?.id ?? null,
        pendingApprovalId: moved.pendingApproval?.id ?? null,
      },
    });
    tx.emit({ type: 'issue.changed', issueId: issue.id });
    tx.emit({
      type: 'delivery.decided',
      issueId: issue.id,
      decision: decision.kind,
      actor: eventActor(actor),
    });
    return {
      issue: (await findIssue(tx.conn, issue.id)) ?? moved.issue,
      pendingApproval: moved.pendingApproval,
      comment,
    };
  });
}

export function createDeliveryService(deps: DeliveryDeps): DeliveryService {
  return {
    accept: (actor, idOrKey, input) =>
      decide(deps, actor, idOrKey, {
        kind: 'accepted',
        comment: commentText(input?.comment, false),
        target: doneStatus,
        trigger: false,
      }),
    requestChanges: (actor, idOrKey, input) =>
      decide(deps, actor, idOrKey, {
        kind: 'changesRequested',
        comment: commentText(input?.comment, true),
        target: (view) => (view.isKnown('in_progress') ? 'in_progress' : null),
        trigger: true,
      }),
  };
}
