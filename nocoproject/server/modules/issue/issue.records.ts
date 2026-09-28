/**
 * Row mapping and lookups for the `issues` table.
 *
 * Iteration 2: `deletedAt` soft-deletes an issue (only an intake revert does this). Lookups here skip deleted issues,
 * so they are 404 everywhere and drop out of lists, counts and blocking.
 */
import type { Conn } from '../shared/db.js';
import { bool, iso, isoOrNull, num, str, unique } from '../shared/db.js';
import type {
  ExecutionMode,
  ExecutorType,
  IssueOriginType,
  IssuePriority,
  IssueProcess,
  IssueRef,
  IssueV4,
} from '../shared/protocol.js';

export const ISSUE_PRIORITIES: readonly IssuePriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];

const RUN_PRIORITY: Readonly<Record<IssuePriority, number>> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

/** Numeric run priority derived from the issue priority (higher is claimed first). */
export function runPriorityOf(priority: IssuePriority): number {
  return RUN_PRIORITY[priority] ?? 0;
}

export function isIssuePriority(value: unknown): value is IssuePriority {
  return (
    typeof value === 'string' &&
    (ISSUE_PRIORITIES as readonly string[]).includes(value)
  );
}

export function isExecutorType(value: unknown): value is ExecutorType {
  return value === 'user' || value === 'agent' || value === 'none';
}

function executionModeOf(value: unknown): ExecutionMode {
  return value === 'session' ? 'session' : 'task';
}

function originTypeOf(value: unknown): IssueOriginType {
  return value === 'intake' || value === 'agent' || value === 'pm'
    ? value
    : 'manual';
}

function processOf(value: unknown): IssueProcess {
  return value === 'design_first' ? 'design_first' : 'direct';
}

/** The full row (iteration 4: `process`, `designApprovedAt`, `designApprovedById`). */
export function mapIssue(row: Record<string, unknown>): IssueV4 {
  return {
    id: str(row.id) ?? '',
    number: num(row.number),
    identifier: str(row.identifier) ?? '',
    title: str(row.title) ?? '',
    description: str(row.description) ?? '',
    statusKey: str(row.statusKey) ?? '',
    priority: isIssuePriority(row.priority) ? row.priority : 'none',
    ownerUserId: str(row.ownerUserId),
    executorType: isExecutorType(row.executorType) ? row.executorType : 'none',
    executorId: str(row.executorId),
    parentIssueId: str(row.parentIssueId),
    projectId: str(row.projectId),
    revision: num(row.revision, 1),
    lastActivityAt: iso(row.lastActivityAt),
    createdById: str(row.createdById),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    stage:
      row.stage === null || row.stage === undefined ? null : num(row.stage),
    startDate: str(row.startDate),
    dueDate: str(row.dueDate),
    autoExecuteSubtasks: bool(row.autoExecuteSubtasks),
    suggestedExecutorAgentId: str(row.suggestedExecutorAgentId),
    executionMode: executionModeOf(row.executionMode),
    originType: originTypeOf(row.originType),
    originId: str(row.originId),
    process: processOf(row.process),
    designApprovedAt: isoOrNull(row.designApprovedAt),
    designApprovedById: str(row.designApprovedById),
  };
}

export function issueRef(issue: IssueRef): IssueRef {
  return { id: issue.id, identifier: issue.identifier, title: issue.title };
}

/** Issues by id, in one query (deleted issues are left out). */
export async function issuesByIds(
  conn: Conn,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, IssueV4>> {
  const wanted = unique(ids);
  if (wanted.length === 0) return new Map();
  const rows = await conn.query
    .selectFrom('issues')
    .selectAll()
    .where('id', 'in', wanted)
    .where('deletedAt', 'is', null)
    .execute();
  return new Map(rows.map((row) => [str(row.id) ?? '', mapIssue(row)]));
}

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/u;

/** Finds an issue by id or by its identifier (`NP-12`); a deleted issue is not found. */
export async function findIssue(
  conn: Conn,
  idOrKey: string,
): Promise<IssueV4 | null> {
  const byId = await conn.query
    .selectFrom('issues')
    .selectAll()
    .where('id', '=', idOrKey)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (byId) return mapIssue(byId);
  if (!IDENTIFIER_PATTERN.test(idOrKey)) return null;
  const byKey = await conn.query
    .selectFrom('issues')
    .selectAll()
    .where('identifier', 'in', unique([idOrKey, idOrKey.toUpperCase()]))
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  return byKey ? mapIssue(byKey) : null;
}
