/**
 * The approval gate seam (docs/phase1/iteration-2-contract.md §D, 方案 §8).
 *
 * Business modules depend on this interface only. Today's implementation is `approval/approval.gateway.ts`
 * (`DbApprovalGateway`, the `approvalRequests` table), which is @temporary(nocobase-official): 待替换为 NocoBase 官方
 * 工作流审批. When the official capability ships, a new `ApprovalGateway` replaces it wholesale; the status enum
 * (`APPROVAL_STATUSES`), the approver roles and the domain event names below must not change. The "替换检查清单" test
 * (`tests/logic/np-approval.test.ts`) runs the same cases against the database gateway and an in-memory double.
 *
 * Rules every implementation keeps:
 * - `gate` is called by the status machine before a transition is applied, inside that transaction. A transition
 *   without `approval`, a system actor, an actor who is one of the approvers, or approvers that resolve to nobody →
 *   `pass` (with the reason). Otherwise a pending request is created, the status stays, and approvers are asked.
 * - A second pending request for the same issue and target status → 409 `APPROVAL_PENDING`.
 * - `approve` applies the transition on the approver's behalf (through `ApprovalHooks.applyTransition`); `reject`
 *   leaves the status. Only a listed approver may decide (403); a decided request → 409 `APPROVAL_DECIDED`.
 * - `cancelStale` cancels pending requests of an issue whose status moved by another path, or became terminal.
 * - Phase 2 (NP-77 §2): `ApprovalHooks.applyTransition` answers `{ applied: false, code, message }` when the
 *   transition's entry conditions no longer hold. The request is then `cancelled` (stale) instead of approved, the
 *   decision still commits, and the approvers and requester are told (`approval.stale`).
 */
import type { Actor } from './activity.js';
import type { Tx } from './db.js';
import type {
  ApprovalRequest,
  ApproverRole,
  IssueV1,
  TransitionApproval,
} from './protocol.js';

export { APPROVAL_STATUSES, APPROVER_ROLES } from './protocol.js';
export type {
  ApprovalRequest,
  ApprovalStatus,
  ApproverRole,
} from './protocol.js';

export interface ApprovalGateInput {
  readonly issue: IssueV1;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly actor: Actor;
  /** The transition's `approval` from the issue's workflow; null when it has none. */
  readonly approval: TransitionApproval | null;
}

export type ApprovalPassReason = 'none' | 'system' | 'self' | 'noApprover';

export type ApprovalGateResult =
  | { readonly kind: 'pass'; readonly reason: ApprovalPassReason }
  | {
      readonly kind: 'pending';
      readonly requestId: string;
      readonly request: ApprovalRequest;
    };

export interface ApprovalGateway {
  gate(input: ApprovalGateInput, tx: Tx): Promise<ApprovalGateResult>;
  approve(
    requestId: string,
    actor: Actor,
    comment?: string | null,
  ): Promise<ApprovalRequest>;
  reject(
    requestId: string,
    actor: Actor,
    comment?: string | null,
  ): Promise<ApprovalRequest>;
  /** Pending requests plus the five most recently decided ones, newest first. */
  listForIssue(issueId: string): Promise<ApprovalRequest[]>;
  /** Pending requests the user may decide. */
  listPending(userId: string): Promise<ApprovalRequest[]>;
  /** The issue now has `currentStatus` (terminal or not): cancel its pending requests that no longer apply. */
  cancelStale(
    tx: Tx,
    issueId: string,
    currentStatus: string,
    terminal: boolean,
  ): Promise<void>;
}

/** Whether an approved transition was applied; not when its entry conditions failed (Phase 2). */
export type ApprovalApplyResult =
  | { readonly applied: true }
  | {
      readonly applied: false;
      readonly code: string;
      readonly message: string;
    };

/** What the business side lends any gateway implementation. */
export interface ApprovalHooks {
  /** Applies `request.toStatus` on behalf of `approver` (status activity actor = approver), skipping the gate. */
  applyTransition(
    tx: Tx,
    request: ApprovalRequest,
    approver: Actor,
  ): Promise<ApprovalApplyResult>;
  /** The approver user ids for `roles` on this issue (owner, project lead, owner/admin members). */
  resolveApprovers(
    tx: Tx,
    issue: IssueV1,
    roles: readonly ApproverRole[],
  ): Promise<string[]>;
}
