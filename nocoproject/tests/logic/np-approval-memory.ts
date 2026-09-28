/**
 * `MemoryApprovalGateway`: an in-memory `ApprovalGateway` standing in for "the official implementation" in the
 * replacement checklist test (方案 §8). It keeps requests in a Map and uses only what the interface and
 * `ApprovalHooks` give it, so the business code passing the shared cases with it shows the seam is sufficient.
 * It writes no activities and emits no events (those belong to the implementation, not the interface).
 */
import type { Actor } from '../../server/modules/shared/activity.ts';
import type {
  ApprovalGateInput,
  ApprovalGateResult,
  ApprovalGateway,
  ApprovalHooks,
} from '../../server/modules/shared/approval.ts';
import {
  conflict,
  forbidden,
  notFound,
} from '../../server/modules/shared/errors.ts';
import type { TxRunner } from '../../server/modules/shared/db.ts';
import type { ApprovalRequest } from '../../server/modules/shared/protocol.ts';

export function createMemoryApprovalGateway(context: {
  tx: TxRunner;
  hooks: () => ApprovalHooks;
}): ApprovalGateway & { readonly requests: Map<string, ApprovalRequest> } {
  const requests = new Map<string, ApprovalRequest>();
  let counter = 0;

  function save(request: ApprovalRequest): ApprovalRequest {
    requests.set(request.id, request);
    return request;
  }

  async function gate(
    input: ApprovalGateInput,
    tx: Parameters<ApprovalGateway['gate']>[1],
  ): Promise<ApprovalGateResult> {
    if (!input.approval) return { kind: 'pass', reason: 'none' };
    if (input.actor.type === 'system')
      return { kind: 'pass', reason: 'system' };
    const approvers = await context
      .hooks()
      .resolveApprovers(tx, input.issue, input.approval.approvers);
    if (approvers.length === 0) return { kind: 'pass', reason: 'noApprover' };
    if (
      input.actor.type === 'user' &&
      input.actor.id &&
      approvers.includes(input.actor.id)
    )
      return { kind: 'pass', reason: 'self' };
    for (const request of requests.values())
      if (
        request.issueId === input.issue.id &&
        request.toStatus === input.toStatus &&
        request.status === 'pending'
      )
        throw conflict('APPROVAL_PENDING', 'Already waiting for approval.');
    counter += 1;
    const at = new Date().toISOString();
    const request = save({
      id: `mem-${counter}`,
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      issueTitle: input.issue.title,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      requestedByType: input.actor.type === 'agent' ? 'agent' : 'user',
      requestedById: input.actor.id ?? '',
      requestedByName: null,
      requestedRunId: input.actor.runId ?? null,
      approverUserIds: approvers,
      status: 'pending',
      decidedById: null,
      decidedByName: null,
      decidedAt: null,
      comment: null,
      createdAt: at,
      updatedAt: at,
    });
    return { kind: 'pending', requestId: request.id, request };
  }

  async function decide(
    requestId: string,
    actor: Actor,
    status: 'approved' | 'rejected',
    comment: string | null | undefined,
  ): Promise<ApprovalRequest> {
    const request = requests.get(requestId);
    if (!request) throw notFound('Approval request');
    if (
      actor.type !== 'user' ||
      !actor.id ||
      !request.approverUserIds.includes(actor.id)
    )
      throw forbidden('FORBIDDEN', 'Not an approver.');
    if (request.status !== 'pending')
      throw conflict('APPROVAL_DECIDED', 'Already decided.');
    const decided = {
      ...request,
      status,
      decidedById: actor.id,
      decidedAt: new Date().toISOString(),
      comment: comment ?? null,
    };
    save(decided);
    if (status === 'approved') {
      let applied;
      try {
        applied = await context.tx.run((tx) =>
          context.hooks().applyTransition(tx, decided, actor),
        );
      } catch (error) {
        save(request);
        throw error;
      }
      // Phase 2: the entry conditions no longer hold, so the request is cancelled as stale.
      if (!applied.applied) return save({ ...decided, status: 'cancelled' });
    }
    return decided;
  }

  return {
    requests,
    gate,
    approve: (requestId, actor, comment) =>
      decide(requestId, actor, 'approved', comment),
    reject: (requestId, actor, comment) =>
      decide(requestId, actor, 'rejected', comment),
    async listForIssue(issueId) {
      return Array.from(requests.values()).filter(
        (request) => request.issueId === issueId,
      );
    },
    async listPending(userId) {
      return Array.from(requests.values()).filter(
        (request) =>
          request.status === 'pending' &&
          request.approverUserIds.includes(userId),
      );
    },
    async cancelStale(_tx, issueId, currentStatus, terminal) {
      for (const request of requests.values())
        if (
          request.issueId === issueId &&
          request.status === 'pending' &&
          (terminal || request.fromStatus !== currentStatus)
        )
          save({ ...request, status: 'cancelled' });
    },
  };
}
