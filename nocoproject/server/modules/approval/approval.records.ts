// @temporary(nocobase-official): to be replaced by the official NocoBase workflow approval
/**
 * Row mapping for the `approvalRequests` table (docs/phase1/iteration-2-contract.md §D).
 */
import type { Conn } from '../shared/db.js';
import { fromJson, iso, isoOrNull, str } from '../shared/db.js';
import type { ApprovalRequest, ApprovalStatus } from '../shared/protocol.js';
import { APPROVAL_STATUSES } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { issuesByIds } from '../issue/issue.records.js';
import { agentNames } from '../run/run.queries.js';

function statusOf(value: unknown): ApprovalStatus {
  return (APPROVAL_STATUSES as readonly unknown[]).includes(value)
    ? (value as ApprovalStatus)
    : 'pending';
}

export function approverIdsOf(row: Record<string, unknown>): string[] {
  const value = fromJson<unknown>(row.approverUserIds);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Maps rows with issue identifiers and actor names (one query per kind). */
export async function mapApprovals(
  conn: Conn,
  users: UserDirectory,
  rows: readonly Record<string, unknown>[],
): Promise<ApprovalRequest[]> {
  const issues = await issuesByIds(
    conn,
    rows.map((row) => str(row.issueId)),
  );
  const userNames = await users.names(conn, [
    ...rows
      .filter((row) => row.requestedByType === 'user')
      .map((row) => str(row.requestedById)),
    ...rows.map((row) => str(row.decidedById)),
  ]);
  const agents = await agentNames(
    conn,
    rows
      .filter((row) => row.requestedByType === 'agent')
      .map((row) => str(row.requestedById)),
  );
  return rows.map((row) => {
    const issue = issues.get(str(row.issueId) ?? '');
    const requestedByType = row.requestedByType === 'agent' ? 'agent' : 'user';
    const requestedById = str(row.requestedById) ?? '';
    const decidedById = str(row.decidedById);
    return {
      id: str(row.id) ?? '',
      issueId: str(row.issueId) ?? '',
      issueIdentifier: issue?.identifier ?? null,
      issueTitle: issue?.title ?? null,
      fromStatus: str(row.fromStatus) ?? '',
      toStatus: str(row.toStatus) ?? '',
      requestedByType,
      requestedById,
      requestedByName:
        (requestedByType === 'agent' ? agents : userNames).get(requestedById) ??
        null,
      requestedRunId: str(row.requestedRunId),
      approverUserIds: approverIdsOf(row),
      status: statusOf(row.status),
      decidedById,
      decidedByName: decidedById ? (userNames.get(decidedById) ?? null) : null,
      decidedAt: isoOrNull(row.decidedAt),
      comment: str(row.comment),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  });
}
