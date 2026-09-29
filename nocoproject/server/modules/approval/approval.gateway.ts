// @temporary(nocobase-official): to be replaced by the official NocoBase workflow approval
/**
 * `DbApprovalGateway`: today's implementation of `shared/approval.ts`, backed by the `approvalRequests` table. The
 * rules are in the interface file; this implementation adds the activities (`approval_requested`, `approval_self`,
 * `approval_no_approver`, `approval_approved`, `approval_rejected`) and the `approval.requested` /
 * `approval.decided` domain events the notification module turns into decision cards and `approval_decided` notices;
 * Phase 2 adds `approval_stale` / `approval.stale` for an approval whose entry conditions no longer hold.
 *
 * Replace this module wholesale when the official capability ships; nothing outside `approval/` imports it except
 * the wiring in `services.ts`.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import type {
  ApprovalGateInput,
  ApprovalGateResult,
  ApprovalGateway,
  ApprovalHooks,
} from '../shared/approval.js';
import { forbid } from '../shared/authz.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { isUniqueViolation, now, toJson } from '../shared/db.js';
import { conflict, notFound } from '../shared/errors.js';
import type { EventActor } from '../shared/events.js';
import type { IdSource } from '../shared/ids.js';
import type { ApprovalRequest } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { approverIdsOf, mapApprovals } from './approval.records.js';

export interface DbApprovalGatewayDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly hooks: () => ApprovalHooks;
}

const RECENT_DECIDED = 5;
const COMMENT_MAX = 10_000;

function eventActor(actor: Actor): EventActor {
  return { type: actor.type, id: actor.id };
}

function cleanComment(comment: string | null | undefined): string | null {
  if (typeof comment !== 'string' || !comment.trim()) return null;
  return comment.trim().slice(0, COMMENT_MAX);
}

async function findRow(
  tx: Tx,
  requestId: string,
): Promise<Record<string, unknown>> {
  const row = await tx.conn.query
    .selectFrom('approvalRequests')
    .selectAll()
    .where('id', '=', requestId)
    .executeTakeFirst();
  if (!row) throw notFound('Approval request');
  return row;
}

async function insertRequest(
  deps: DbApprovalGatewayDeps,
  tx: Tx,
  input: ApprovalGateInput,
  approverUserIds: readonly string[],
): Promise<ApprovalRequest> {
  const { issue, actor } = input;
  const pending = await tx.conn.query
    .selectFrom('approvalRequests')
    .select('id')
    .where('issueId', '=', issue.id)
    .where('toStatus', '=', input.toStatus)
    .where('status', '=', 'pending')
    .exists();
  if (pending)
    throw conflict(
      'APPROVAL_PENDING',
      `A request to move ${issue.identifier} to ${input.toStatus} is already waiting for approval.`,
    );
  const timestamp = now();
  const row = {
    id: deps.ids.next(),
    issueId: issue.id,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    requestedByType: actor.type === 'agent' ? 'agent' : 'user',
    requestedById: actor.id ?? '',
    requestedRunId: actor.runId ?? null,
    approverUserIds: toJson(approverUserIds),
    status: 'pending',
    decidedById: null,
    decidedAt: null,
    comment: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await tx.conn.transaction(async (inner) => {
      await inner.query.insertInto('approvalRequests').values(row).execute();
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict(
        'APPROVAL_PENDING',
        'This transition is already waiting for approval.',
      );
    throw error;
  }
  const [request] = await mapApprovals(tx.conn, deps.users, [row]);
  return request;
}

async function gate(
  deps: DbApprovalGatewayDeps,
  input: ApprovalGateInput,
  tx: Tx,
): Promise<ApprovalGateResult> {
  const { issue, actor, approval } = input;
  if (!approval) return { kind: 'pass', reason: 'none' };
  if (actor.type === 'system') return { kind: 'pass', reason: 'system' };
  const details = { from: input.fromStatus, to: input.toStatus };
  const approvers = await deps
    .hooks()
    .resolveApprovers(tx, issue, approval.approvers);
  if (approvers.length === 0) {
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action: 'approval_no_approver',
      details: { ...details, approvers: approval.approvers },
    });
    return { kind: 'pass', reason: 'noApprover' };
  }
  if (actor.type === 'user' && actor.id && approvers.includes(actor.id)) {
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action: 'approval_self',
      details,
    });
    return { kind: 'pass', reason: 'self' };
  }
  const request = await insertRequest(deps, tx, input, approvers);
  await deps.activity.record(tx.conn, {
    issueId: issue.id,
    actor,
    action: 'approval_requested',
    details: { ...details, requestId: request.id, approverUserIds: approvers },
  });
  tx.emit({
    type: 'approval.requested',
    requestId: request.id,
    issueId: issue.id,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    approverUserIds: approvers,
    actor: eventActor(actor),
  });
  tx.emit({ type: 'issue.changed', issueId: issue.id });
  return { kind: 'pending', requestId: request.id, request };
}

/**
 * Phase 2: the approved transition no longer meets its entry conditions (a checklist, a merged pull request). The
 * request is cancelled as stale in the same transaction, so the decision commits without moving the issue.
 */
async function markStale(
  deps: DbApprovalGatewayDeps,
  tx: Tx,
  request: ApprovalRequest,
  actor: Actor,
  failure: { readonly code: string; readonly message: string },
): Promise<ApprovalRequest> {
  const timestamp = now();
  await tx.conn.query
    .updateTable('approvalRequests')
    .set({ status: 'cancelled', updatedAt: timestamp })
    .where('id', '=', request.id)
    .execute();
  await deps.activity.record(tx.conn, {
    issueId: request.issueId,
    actor,
    action: 'approval_stale',
    details: {
      requestId: request.id,
      from: request.fromStatus,
      to: request.toStatus,
      code: failure.code,
      message: failure.message,
    },
  });
  const requestedBy: EventActor = {
    type: request.requestedByType,
    id: request.requestedById,
  };
  tx.emit({
    type: 'approval.decided',
    requestId: request.id,
    issueId: request.issueId,
    status: 'cancelled',
    fromStatus: request.fromStatus,
    toStatus: request.toStatus,
    requestedBy,
    actor: eventActor(actor),
    comment: request.comment,
  });
  tx.emit({
    type: 'approval.stale',
    requestId: request.id,
    issueId: request.issueId,
    fromStatus: request.fromStatus,
    toStatus: request.toStatus,
    approverUserIds: request.approverUserIds,
    requestedBy,
    code: failure.code,
    message: failure.message,
    actor: eventActor(actor),
  });
  tx.emit({ type: 'issue.changed', issueId: request.issueId });
  const [stale] = await mapApprovals(tx.conn, deps.users, [
    await findRow(tx, request.id),
  ]);
  return stale;
}

async function decide(
  deps: DbApprovalGatewayDeps,
  requestId: string,
  actor: Actor,
  decision: 'approved' | 'rejected',
  comment: string | null,
): Promise<ApprovalRequest> {
  return deps.tx.run(async (tx) => {
    const row = await findRow(tx, requestId);
    if (actor.type !== 'user' || !actor.id)
      forbid('Only a member may decide an approval request.');
    if (!approverIdsOf(row).includes(actor.id))
      forbid('Only an approver of this request may decide it.');
    if (row.status !== 'pending')
      throw conflict(
        'APPROVAL_DECIDED',
        `This request is already ${String(row.status)}.`,
      );
    const timestamp = now();
    const moved = await tx.conn.query
      .updateTable('approvalRequests')
      .set({
        status: decision,
        decidedById: actor.id,
        decidedAt: timestamp,
        comment,
        updatedAt: timestamp,
      })
      .where('id', '=', requestId)
      .where('status', '=', 'pending')
      .execute();
    if ((moved.updatedCount ?? 0) === 0)
      throw conflict('APPROVAL_DECIDED', 'This request was decided already.');
    const [request] = await mapApprovals(tx.conn, deps.users, [
      await findRow(tx, requestId),
    ]);
    const decided = request;
    await deps.activity.record(tx.conn, {
      issueId: decided.issueId,
      actor,
      action:
        decision === 'approved' ? 'approval_approved' : 'approval_rejected',
      details: {
        requestId,
        from: decided.fromStatus,
        to: decided.toStatus,
        comment,
      },
    });
    if (decision === 'approved') {
      const applied = await deps.hooks().applyTransition(tx, decided, actor);
      if (!applied.applied) return markStale(deps, tx, decided, actor, applied);
    }
    tx.emit({
      type: 'approval.decided',
      requestId,
      issueId: decided.issueId,
      status: decision,
      fromStatus: decided.fromStatus,
      toStatus: decided.toStatus,
      requestedBy: { type: decided.requestedByType, id: decided.requestedById },
      actor: eventActor(actor),
      comment,
    });
    tx.emit({ type: 'issue.changed', issueId: decided.issueId });
    return decided;
  });
}

async function cancelStale(
  tx: Tx,
  issueId: string,
  currentStatus: string,
  terminal: boolean,
): Promise<void> {
  const rows = await tx.conn.query
    .selectFrom('approvalRequests')
    .selectAll()
    .where('issueId', '=', issueId)
    .where('status', '=', 'pending')
    .execute();
  const stale = rows.filter(
    (row) => terminal || row.fromStatus !== currentStatus,
  );
  for (const row of stale) {
    const timestamp = now();
    await tx.conn.query
      .updateTable('approvalRequests')
      .set({ status: 'cancelled', decidedAt: timestamp, updatedAt: timestamp })
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .execute();
    tx.emit({
      type: 'approval.decided',
      requestId: String(row.id),
      issueId,
      status: 'cancelled',
      fromStatus: String(row.fromStatus),
      toStatus: String(row.toStatus),
      requestedBy: {
        type: row.requestedByType === 'agent' ? 'agent' : 'user',
        id: String(row.requestedById),
      },
      actor: { type: 'system', id: null },
      comment: null,
    });
  }
}

export function createDbApprovalGateway(
  deps: DbApprovalGatewayDeps,
): ApprovalGateway {
  return {
    gate: (input, tx) => gate(deps, input, tx),
    approve: (requestId, actor, comment) =>
      decide(deps, requestId, actor, 'approved', cleanComment(comment)),
    reject: (requestId, actor, comment) =>
      decide(deps, requestId, actor, 'rejected', cleanComment(comment)),
    async listForIssue(issueId) {
      const conn = deps.tx.read();
      const pending = await conn.query
        .selectFrom('approvalRequests')
        .selectAll()
        .where('issueId', '=', issueId)
        .where('status', '=', 'pending')
        .orderBy('createdAt', 'desc')
        .execute();
      const decided = await conn.query
        .selectFrom('approvalRequests')
        .selectAll()
        .where('issueId', '=', issueId)
        .where('status', '<>', 'pending')
        .orderBy('updatedAt', 'desc')
        .limit(RECENT_DECIDED)
        .execute();
      return mapApprovals(conn, deps.users, [...pending, ...decided]);
    },
    async listPending(userId) {
      const conn = deps.tx.read();
      const rows = await conn.query
        .selectFrom('approvalRequests')
        .selectAll()
        .where('status', '=', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(1000)
        .execute();
      return mapApprovals(
        conn,
        deps.users,
        rows.filter((row) => approverIdsOf(row).includes(userId)),
      );
    },
    cancelStale: (tx, issueId, currentStatus, terminal) =>
      cancelStale(tx, issueId, currentStatus, terminal),
  };
}
