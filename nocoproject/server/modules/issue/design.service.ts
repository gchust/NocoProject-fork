import { requireCapability } from '../agent/capabilities.js';
/**
 * Design proposals and decisions (docs/phase1/iteration-4-contract.md §B), each in one transaction:
 *
 * - propose (agent, run token, own issue only): a top-level `kind = 'proposal'` comment (never triggers); a
 *   design-first issue still in todo moves to `analysis` first; activity `design_proposed`; event `design.proposed`
 *   (an open `design_review` card picks up the new proposal).
 * - approve (owner, project lead, owner/admin; design-first issues not yet approved): `designApprovedAt/ById`, an
 *   optional comment that triggers nothing, status `in_progress` (when the workflow has it), activity
 *   `design_approved`, a `designApproved` run for the agent executor (it carries the comment).
 * - request changes (any member who can see the issue): clears an earlier approval, status `analysis`, then a
 *   top-level comment that wakes the executor (`comment`), activity `design_changes_requested`.
 *
 * Both decisions emit `design.decided`, which resolves the issue's `design_review` cards.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import { canChangeOwner, forbid, viewerOf } from '../shared/authz.js';
import { requireVisibleIssue } from '../shared/authz.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { now } from '../shared/db.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import type {
  AgentDesignProposalRequest,
  CommentV2,
  DesignApproveRequest,
  DesignDecisionResultV4,
  DesignRequestChangesRequest,
  IssueV4,
} from '../shared/protocol.js';
import { DESIGN_PROPOSAL_MAX, STATUS_ANALYSIS } from '../shared/protocol.js';
import type { CommentService } from '../collaboration/comment.service.js';
import type { RunAuth } from '../run/token.js';
import type { TriggerService } from '../trigger/trigger.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import { eventActor } from './issue.events.js';
import { findIssue } from './issue.records.js';
import type { IssueService } from './issue.service.js';
import { latestProposal } from './process.js';

export interface DesignService {
  /** `idOrKey` must name the run's own issue (403 `ISSUE_NOT_IN_RUN`). */
  propose(
    auth: RunAuth,
    idOrKey: string,
    input: AgentDesignProposalRequest,
  ): Promise<CommentV2>;
  approve(
    actor: Actor,
    idOrKey: string,
    input: DesignApproveRequest,
    /** NP-183: joins the caller's transaction (a plan card). */
    outer?: Tx,
  ): Promise<DesignDecisionResultV4>;
  requestChanges(
    actor: Actor,
    idOrKey: string,
    input: DesignRequestChangesRequest,
    /** NP-183: joins the caller's transaction (a plan card). */
    outer?: Tx,
  ): Promise<DesignDecisionResultV4>;
}

export interface DesignDeps {
  readonly tx: TxRunner;
  readonly activity: ActivityRecorder;
  readonly workflows: WorkflowService;
  readonly issues: () => IssueService;
  readonly comments: () => CommentService;
  readonly triggers: () => TriggerService;
}

function text(value: unknown, code: string, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(code, 'A text is required.');
    return null;
  }
  if (typeof value !== 'string' || value.length > DESIGN_PROPOSAL_MAX)
    throw invalid(
      code,
      'The text must be a string of at most 200000 characters.',
    );
  if (value.trim() === '') {
    if (required) throw invalid(code, 'A text is required.');
    return null;
  }
  return value;
}

async function propose(
  deps: DesignDeps,
  auth: RunAuth,
  idOrKey: string,
  input: AgentDesignProposalRequest,
): Promise<CommentV2> {
  const content = text(input?.content, 'INVALID_CONTENT', true) as string;
  const actor: Actor = { type: 'agent', id: auth.agentId, runId: auth.runId };
  return deps.tx.run(async (tx) => {
    await requireCapability(tx.conn, auth, 'design.propose');
    const issue = await findIssue(tx.conn, idOrKey);
    if (!issue) throw notFound('Issue');
    if (issue.id !== auth.issueId)
      throw forbidden(
        'ISSUE_NOT_IN_RUN',
        'A run token may only write to its own issue.',
      );
    const view = await deps.workflows.forIssue(tx.conn, issue);
    if (
      issue.process === 'design_first' &&
      issue.statusKey === 'todo' &&
      view.isKnown(STATUS_ANALYSIS)
    )
      await deps
        .issues()
        .writeStatusInTx(tx, issue.id, STATUS_ANALYSIS, actor, {
          reason: 'designProposed',
        });
    const { comment } = await deps
      .comments()
      .create(actor, issue.id, { content }, { outer: tx, kind: 'proposal' });
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action: 'design_proposed',
      details: { commentId: comment.id },
    });
    tx.emit({
      type: 'design.proposed',
      issueId: issue.id,
      commentId: comment.id,
      actor: eventActor(actor),
    });
    return comment as CommentV2;
  });
}

async function designIssue(
  tx: Tx,
  actor: Actor,
  idOrKey: string,
): Promise<IssueV4> {
  const viewer = await viewerOf(tx.conn, actor);
  const issue = await requireVisibleIssue(tx.conn, viewer, idOrKey);
  if (issue.process !== 'design_first')
    throw conflict('NOT_DESIGN_FIRST', 'This issue is not design-first.');
  return issue;
}

async function setApproval(
  tx: Tx,
  issue: IssueV4,
  approvedById: string | null,
): Promise<void> {
  const timestamp = now();
  await tx.conn.query
    .updateTable('issues')
    .set({
      designApprovedAt: approvedById ? timestamp : null,
      designApprovedById: approvedById,
      revision: issue.revision + 1,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    })
    .where('id', '=', issue.id)
    .execute();
  tx.emit({ type: 'issue.changed', issueId: issue.id });
}

async function approve(
  deps: DesignDeps,
  actor: Actor,
  idOrKey: string,
  input: DesignApproveRequest,
  outer?: Tx,
): Promise<DesignDecisionResultV4> {
  const note = text(input?.comment, 'INVALID_COMMENT', false);
  return deps.tx.run(async (tx) => {
    const issue = await designIssue(tx, actor, idOrKey);
    if (issue.designApprovedAt)
      throw conflict(
        'DESIGN_ALREADY_APPROVED',
        'The design of this issue is already approved.',
      );
    if (!(await canChangeOwner(tx.conn, await viewerOf(tx.conn, actor), issue)))
      forbid(
        'Only the owner, the project lead or an owner/admin may approve the design.',
      );
    await setApproval(tx, issue, actor.id);
    const comment = note
      ? ((
          await deps
            .comments()
            .create(
              actor,
              issue.id,
              { content: note },
              { outer: tx, trigger: false },
            )
        ).comment as CommentV2)
      : null;
    const view = await deps.workflows.forIssue(tx.conn, issue);
    if (view.isKnown('in_progress') && !view.isTerminal(issue.statusKey))
      await deps.issues().writeStatusInTx(tx, issue.id, 'in_progress', actor, {
        reason: 'designApproved',
      });
    const after = (await findIssue(tx.conn, issue.id)) as IssueV4;
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action: 'design_approved',
      details: {
        from: issue.statusKey,
        to: after.statusKey,
        commentId: comment?.id ?? null,
        proposalCommentId:
          (await latestProposal(tx.conn, issue.id))?.commentId ?? null,
      },
    });
    const triggered = await deps
      .triggers()
      .onDesignApproved(tx, after, actor, comment?.id ?? null);
    tx.emit({
      type: 'design.decided',
      issueId: issue.id,
      decision: 'approved',
      actor: eventActor(actor),
    });
    return { issue: after, comment, triggered };
  }, outer);
}

async function requestChanges(
  deps: DesignDeps,
  actor: Actor,
  idOrKey: string,
  input: DesignRequestChangesRequest,
  outer?: Tx,
): Promise<DesignDecisionResultV4> {
  const note = text(input?.comment, 'INVALID_COMMENT', true) as string;
  return deps.tx.run(async (tx) => {
    const issue = await designIssue(tx, actor, idOrKey);
    if (issue.designApprovedAt) await setApproval(tx, issue, null);
    const view = await deps.workflows.forIssue(tx.conn, issue);
    if (view.isKnown(STATUS_ANALYSIS))
      await deps
        .issues()
        .writeStatusInTx(tx, issue.id, STATUS_ANALYSIS, actor, {
          reason: 'designChangesRequested',
        });
    const created = await deps
      .comments()
      .create(actor, issue.id, { content: note }, { outer: tx });
    const after = (await findIssue(tx.conn, issue.id)) as IssueV4;
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action: 'design_changes_requested',
      details: {
        from: issue.statusKey,
        to: after.statusKey,
        commentId: created.comment.id,
      },
    });
    tx.emit({
      type: 'design.decided',
      issueId: issue.id,
      decision: 'changesRequested',
      actor: eventActor(actor),
    });
    return {
      issue: after,
      comment: created.comment as CommentV2,
      triggered: created.triggered,
    };
  }, outer);
}

export function createDesignService(deps: DesignDeps): DesignService {
  return {
    propose: (auth, idOrKey, input) => propose(deps, auth, idOrKey, input),
    approve: (actor, idOrKey, input, outer) =>
      approve(deps, actor, idOrKey, input, outer),
    requestChanges: (actor, idOrKey, input, outer) =>
      requestChanges(deps, actor, idOrKey, input, outer),
  };
}
