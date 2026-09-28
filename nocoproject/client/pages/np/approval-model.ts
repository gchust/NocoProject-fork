import type { ApprovalRequest, Member } from './types.js';

/**
 * Approval requests as the issue page and the inbox read them (iteration 2 §D). The server decides who may approve;
 * these helpers only keep the buttons away from people it would refuse with 403.
 */

export function pendingApprovals(
  approvals: readonly ApprovalRequest[],
): ApprovalRequest[] {
  return approvals
    .filter((approval) => approval.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Only a listed approver sees approve / reject. */
export function canDecideApproval(
  approval: Pick<ApprovalRequest, 'status' | 'approverUserIds'>,
  userId: string | null | undefined,
): boolean {
  return (
    approval.status === 'pending' &&
    !!userId &&
    approval.approverUserIds.includes(userId)
  );
}

/** Approver names: the server's `approverNames` when present, else looked up in the member list. */
export function approverNames(
  approval: Pick<ApprovalRequest, 'approverUserIds' | 'approverNames'>,
  members: readonly Member[] | undefined,
): string[] {
  if (approval.approverNames && approval.approverNames.length > 0) {
    return [...approval.approverNames];
  }
  return approval.approverUserIds.map(
    (userId) =>
      members?.find((member) => member.userId === userId)?.name ?? userId,
  );
}
