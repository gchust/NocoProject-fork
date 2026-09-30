/**
 * Executor proposals (docs/phase1/iteration-1-contract.md §D). An agent creating a sub-issue for itself (with the
 * parent's `autoExecuteSubtasks` off) or for another agent outside its delegation list leaves a pending proposal;
 * the parent owner's inbox gets one `proposal_pending` decision card per parent. Accepting sets the executor and runs
 * the assign rule with trigger type `proposalAccepted`; the caller must be allowed to invoke the proposed agent.
 *
 * Phase 2 (NP-77 §3): a `suggestExecutor` stage action leaves a proposal with `source = workflow`, no proposing agent
 * and `stageStatusKey`; its card sits on its own issue (not the parent's), and leaving that status supersedes it
 * (`status = superseded`, `workflow/stage-actions.ts`).
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  loadAgentAccess,
  canInvokeAgent,
  forbid,
  requireVisibleIssue,
  viewerOf,
  type Viewer,
} from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { iso, isoOrNull, now, str, unique } from '../shared/db.js';
import { conflict, notFound } from '../shared/errors.js';
import { NpError } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AcceptAllProposalsResponseV5 as AcceptAllProposalsResponse,
  DecideProposalRequest,
  ExecutorProposalV5 as ExecutorProposal,
  IssueV1,
  ProposalSource,
  ProposalStatusV5,
} from '../shared/protocol.js';
import { findIssue, issuesByIds } from '../issue/issue.records.js';
import type { IssueService } from '../issue/issue.service.js';
import { agentNames } from '../run/run.queries.js';
import { optionalText } from '../shared/validate.js';

export interface ProposalService {
  accept(
    actor: Actor,
    issueIdOrKey: string,
    proposalId: string,
    input: DecideProposalRequest,
    /** NP-183: joins the caller's transaction (a plan card). */
    outer?: Tx,
  ): Promise<ExecutorProposal>;
  reject(
    actor: Actor,
    issueIdOrKey: string,
    proposalId: string,
    input: DecideProposalRequest,
    /** NP-183: joins the caller's transaction (a plan card). */
    outer?: Tx,
  ): Promise<ExecutorProposal>;
  acceptAll(
    actor: Actor,
    parentIdOrKey: string,
  ): Promise<AcceptAllProposalsResponse>;
}

export interface ProposalDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly activity: ActivityRecorder;
  readonly issues: () => IssueService;
}

function isProposalStatus(value: unknown): value is ProposalStatusV5 {
  return (
    value === 'pending' ||
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'autoAccepted' ||
    value === 'superseded'
  );
}

async function mapProposals(
  conn: Conn,
  rows: readonly Record<string, unknown>[],
): Promise<ExecutorProposal[]> {
  const issues = await issuesByIds(
    conn,
    rows.map((row) => str(row.issueId)),
  );
  const names = await agentNames(conn, [
    ...rows.map((row) => str(row.proposedAgentId)),
    ...rows.map((row) => str(row.proposedByAgentId)),
  ]);
  return rows.map((row) => {
    const issue = issues.get(str(row.issueId) ?? '');
    const proposedAgentId = str(row.proposedAgentId) ?? '';
    const proposedByAgentId = str(row.proposedByAgentId);
    return {
      id: str(row.id) ?? '',
      issueId: str(row.issueId) ?? '',
      issueIdentifier: issue?.identifier ?? '',
      issueTitle: issue?.title ?? '',
      proposedAgentId,
      proposedAgentName: names.get(proposedAgentId) ?? proposedAgentId,
      proposedByAgentId,
      proposedByAgentName: proposedByAgentId
        ? (names.get(proposedByAgentId) ?? proposedByAgentId)
        : null,
      sourceRunId: str(row.sourceRunId),
      source: row.source === 'workflow' ? 'workflow' : 'agent',
      stageStatusKey: str(row.stageStatusKey),
      status: isProposalStatus(row.status) ? row.status : 'pending',
      decidedById: str(row.decidedById),
      decidedAt: isoOrNull(row.decidedAt),
      reason: str(row.reason),
      createdAt: iso(row.createdAt),
    };
  });
}

/** Proposals on an issue and on its direct children, oldest first. */
export async function proposalsFor(
  conn: Conn,
  issueId: string,
): Promise<ExecutorProposal[]> {
  const children = await conn.query
    .selectFrom('issues')
    .select('id')
    .where('parentIssueId', '=', issueId)
    .execute();
  const ids = unique([issueId, ...children.map((row) => str(row.id))]);
  const rows = await conn.query
    .selectFrom('executorProposals')
    .selectAll()
    .where('issueId', 'in', ids)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return mapProposals(conn, rows);
}

export async function insertProposal(
  tx: Tx,
  deps: Pick<ProposalDeps, 'ids' | 'activity'>,
  input: {
    issue: IssueV1;
    proposedAgentId: string;
    /** Null for a workflow suggestion (Phase 2). */
    proposedByAgentId: string | null;
    sourceRunId: string | null;
    status: 'pending' | 'autoAccepted';
    actor: Actor;
    source?: ProposalSource;
    stageStatusKey?: string | null;
  },
): Promise<ExecutorProposal> {
  const source = input.source ?? 'agent';
  const id = deps.ids.next();
  const timestamp = now();
  const row = {
    id,
    issueId: input.issue.id,
    proposedAgentId: input.proposedAgentId,
    proposedByAgentId: input.proposedByAgentId,
    sourceRunId: input.sourceRunId,
    status: input.status,
    decidedById: null,
    decidedAt: input.status === 'autoAccepted' ? timestamp : null,
    reason: null,
    source,
    stageStatusKey: input.stageStatusKey ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await tx.conn.query.insertInto('executorProposals').values(row).execute();
  await deps.activity.record(tx.conn, {
    issueId: input.issue.id,
    actor: input.actor,
    action:
      input.status === 'pending'
        ? 'proposal_created'
        : 'proposal_auto_accepted',
    details: {
      proposalId: id,
      proposedAgentId: input.proposedAgentId,
      ...(source === 'workflow'
        ? { source, stageStatusKey: input.stageStatusKey ?? null }
        : {}),
    },
  });
  if (input.status === 'pending')
    tx.emit({
      type: 'proposal.created',
      proposalId: id,
      issueId: input.issue.id,
      // A workflow suggestion is decided on its own issue, not on the parent's card.
      parentIssueId: source === 'workflow' ? null : input.issue.parentIssueId,
      proposedByAgentId: input.proposedByAgentId,
      proposedAgentId: input.proposedAgentId,
      source,
    });
  const [mapped] = await mapProposals(tx.conn, [row]);
  return mapped;
}

async function load(
  tx: Tx,
  viewer: Viewer,
  issueIdOrKey: string,
  proposalId: string,
): Promise<{ row: Record<string, unknown>; issue: IssueV1 }> {
  const anchor = await requireVisibleIssue(tx.conn, viewer, issueIdOrKey);
  const row = await tx.conn.query
    .selectFrom('executorProposals')
    .selectAll()
    .where('id', '=', proposalId)
    .executeTakeFirst();
  if (!row) throw notFound('Proposal');
  const issue = await findIssue(tx.conn, str(row.issueId) ?? '');
  // The proposal belongs to this issue, or to one of its direct children (the parent's card).
  if (!issue || (issue.id !== anchor.id && issue.parentIssueId !== anchor.id))
    throw notFound('Proposal');
  if (row.status !== 'pending')
    throw conflict(
      'PROPOSAL_DECIDED',
      'This proposal has already been decided.',
    );
  return { row, issue };
}

async function decide(
  deps: ProposalDeps,
  tx: Tx,
  viewer: Viewer,
  actor: Actor,
  target: { row: Record<string, unknown>; issue: IssueV1 },
  status: 'accepted' | 'rejected',
  reason: string | null,
): Promise<ExecutorProposal> {
  const { row, issue } = target;
  const proposalId = str(row.id) ?? '';
  const proposedAgentId = str(row.proposedAgentId) ?? '';
  if (status === 'accepted') {
    const agent = await loadAgentAccess(tx.conn, proposedAgentId);
    if (!agent || !(await canInvokeAgent(tx.conn, viewer.userId, agent)))
      forbid('You do not have access to the proposed agent.');
  }
  const timestamp = now();
  await tx.conn.query
    .updateTable('executorProposals')
    .set({
      status,
      decidedById: viewer.userId,
      decidedAt: timestamp,
      reason,
      updatedAt: timestamp,
    })
    .where('id', '=', proposalId)
    .execute();
  await deps.activity.record(tx.conn, {
    issueId: issue.id,
    actor,
    action: status === 'accepted' ? 'proposal_accepted' : 'proposal_rejected',
    details: { proposalId, proposedAgentId, reason },
  });
  if (status === 'accepted') {
    // Any other pending proposal on the same issue is superseded.
    await tx.conn.query
      .updateTable('executorProposals')
      .set({
        status: 'rejected',
        decidedById: viewer.userId,
        decidedAt: timestamp,
        reason: 'superseded',
        updatedAt: timestamp,
      })
      .where('issueId', '=', issue.id)
      .where('status', '=', 'pending')
      .execute();
    await deps
      .issues()
      .assignAgentInTx(tx, issue, proposedAgentId, actor, 'proposalAccepted');
  } else if (issue.suggestedExecutorAgentId === proposedAgentId) {
    await tx.conn.query
      .updateTable('issues')
      .set({ suggestedExecutorAgentId: null, updatedAt: timestamp })
      .where('id', '=', issue.id)
      .execute();
  }
  tx.emit({ type: 'issue.changed', issueId: issue.id });
  tx.emit({
    type: 'proposal.decided',
    proposalId,
    issueId: issue.id,
    parentIssueId: row.source === 'workflow' ? null : issue.parentIssueId,
    actor: { type: actor.type, id: actor.id },
  });
  const updated = await tx.conn.query
    .selectFrom('executorProposals')
    .selectAll()
    .where('id', '=', proposalId)
    .executeTakeFirst();
  return (await mapProposals(tx.conn, [updated ?? row]))[0];
}

function decideOne(
  deps: ProposalDeps,
  status: 'accepted' | 'rejected',
  actor: Actor,
  issueIdOrKey: string,
  proposalId: string,
  input: DecideProposalRequest,
  outer?: Tx,
): Promise<ExecutorProposal> {
  return deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    const target = await load(tx, viewer, issueIdOrKey, proposalId);
    return decide(
      deps,
      tx,
      viewer,
      actor,
      target,
      status,
      optionalText(input?.reason, 'reason', 2000),
    );
  }, outer);
}

async function acceptAll(
  deps: ProposalDeps,
  actor: Actor,
  parentIdOrKey: string,
): Promise<AcceptAllProposalsResponse> {
  return deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    const parent = await requireVisibleIssue(tx.conn, viewer, parentIdOrKey);
    const pending = (await proposalsFor(tx.conn, parent.id)).filter(
      (proposal) => proposal.status === 'pending',
    );
    const accepted: ExecutorProposal[] = [];
    const skipped: AcceptAllProposalsResponse['skipped'][number][] = [];
    for (const proposal of pending) {
      try {
        // Savepoint per proposal: a refused one must not undo the others.
        const result = await tx.conn.transaction(async (inner) => {
          const unit: Tx = { conn: inner, emit: (event) => tx.emit(event) };
          const target = await load(unit, viewer, parent.id, proposal.id);
          return decide(deps, unit, viewer, actor, target, 'accepted', null);
        });
        accepted.push(result);
      } catch (error) {
        if (!(error instanceof NpError)) throw error;
        skipped.push({
          proposalId: proposal.id,
          code: error.code,
          message: error.message,
        });
      }
    }
    return { accepted, skipped };
  });
}

export function createProposalService(deps: ProposalDeps): ProposalService {
  return {
    accept: (actor, issueIdOrKey, proposalId, input, outer) =>
      decideOne(
        deps,
        'accepted',
        actor,
        issueIdOrKey,
        proposalId,
        input,
        outer,
      ),
    reject: (actor, issueIdOrKey, proposalId, input, outer) =>
      decideOne(
        deps,
        'rejected',
        actor,
        issueIdOrKey,
        proposalId,
        input,
        outer,
      ),
    acceptAll: (actor, parentIdOrKey) => acceptAll(deps, actor, parentIdOrKey),
  };
}
