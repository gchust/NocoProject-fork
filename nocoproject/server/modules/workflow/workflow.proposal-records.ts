/**
 * Row mapping and input checks for workflow template proposals (NP-77 stage 2, `workflow.proposals.ts`).
 */
import type { Conn } from '../shared/db.js';
import { fromJson, iso, isoOrNull, num, str, unique } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  WorkflowDefinitionV5,
  WorkflowDiff,
  WorkflowProposal,
  WorkflowProposalStatus,
} from '../shared/protocol.js';
import {
  WORKFLOW_COMMENT_MAX,
  WORKFLOW_REASON_MAX,
  WORKFLOW_TEMPLATE_NAME_MAX,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { agentNames } from '../run/run.queries.js';
import { diffWorkflows, runExecutorAgentIds } from './workflow.diff.js';
import { projectCountOf } from './workflow.revisions.js';

export function validateReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || reason.length > WORKFLOW_REASON_MAX)
    throw invalid(
      'INVALID_REASON',
      `reason is required (at most ${WORKFLOW_REASON_MAX} characters).`,
    );
  return reason;
}

export function validateName(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required)
      throw invalid(
        'INVALID_NAME',
        'name is required when copying a template.',
      );
    return null;
  }
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > WORKFLOW_TEMPLATE_NAME_MAX)
    throw invalid(
      'INVALID_NAME',
      `name must be text of 1 to ${WORKFLOW_TEMPLATE_NAME_MAX} characters.`,
    );
  return name;
}

export function validateComment(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > WORKFLOW_COMMENT_MAX)
    throw invalid(
      'INVALID_COMMENT',
      `comment must be text of at most ${WORKFLOW_COMMENT_MAX} characters.`,
    );
  return value;
}

export function definitionOf(value: unknown): WorkflowDefinitionV5 {
  return fromJson<WorkflowDefinitionV5>(value) as WorkflowDefinitionV5;
}

/** The structured diff of a proposal row against the definition it was based on. */
export function proposalDiff(
  row: Record<string, unknown>,
  names: ReadonlyMap<string, string>,
): WorkflowDiff {
  return diffWorkflows({
    base: definitionOf(row.baseDefinition),
    next: definitionOf(row.definition),
    baseName: str(row.baseName) ?? '',
    nextName: str(row.name),
    agentNames: names,
  });
}

/** Counts for the decision card (`workflow.proposed.changes`). */
export function diffCounts(diff: WorkflowDiff): Record<string, number> {
  return {
    statusesAdded: diff.statuses.added.length,
    statusesRemoved: diff.statuses.removed.length,
    statusesChanged: diff.statuses.changed.length,
    transitionsAdded: diff.transitions.added.length,
    transitionsRemoved: diff.transitions.removed.length,
    transitionsChanged: diff.transitions.changed.length,
    statusesWithActionChanges: diff.actions.length,
    runExecutorAgents: diff.runExecutorAgents.length,
    newRunExecutorAgents: diff.runExecutorAgents.filter((entry) => entry.isNew)
      .length,
  };
}

export interface MapContext {
  readonly users: UserDirectory;
  /** Whether the caller may decide (owner/admin); pending proposals only. */
  readonly canDecide: boolean;
  /** Source issues the caller may not see lose their reference. */
  readonly canSeeIssue: (issueId: string) => Promise<boolean>;
}

export async function mapProposal(
  conn: Conn,
  row: Record<string, unknown>,
  context: MapContext,
): Promise<WorkflowProposal> {
  const templateId = str(row.templateId);
  const copyFromId = str(row.copyFromId);
  const templateRows = await conn.query
    .selectFrom('workflowTemplates')
    .selectAll()
    .where('id', 'in', [...unique([templateId, copyFromId]), ''])
    .execute();
  const templates = new Map(templateRows.map((item) => [str(item.id), item]));
  const template = templateId ? templates.get(templateId) : undefined;
  const definition = definitionOf(row.definition);
  const agentIds = unique([
    str(row.proposedByAgentId),
    ...runExecutorAgentIds(definition),
  ]);
  const agents = await agentNames(conn, agentIds);
  const decidedById = str(row.decidedById);
  const deciders = await context.users.names(conn, [decidedById]);
  const status = (str(row.status) ?? 'pending') as WorkflowProposalStatus;
  const kind = copyFromId ? 'copy' : 'update';
  const sourceIssueId = str(row.sourceIssueId);
  const visibleIssue =
    sourceIssueId && (await context.canSeeIssue(sourceIssueId))
      ? sourceIssueId
      : null;
  const issue = visibleIssue
    ? await conn.query
        .selectFrom('issues')
        .select('identifier')
        .where('id', '=', visibleIssue)
        .executeTakeFirst()
    : undefined;
  const baseRevision = num(row.baseRevision, 1);
  const currentRevision =
    kind === 'update' && template ? num(template.revision, 1) : null;
  return {
    id: str(row.id) ?? '',
    kind,
    templateId,
    templateName: template ? (str(template.name) ?? null) : null,
    copyFromId,
    copyFromName: copyFromId
      ? (str(templates.get(copyFromId)?.name) ?? null)
      : null,
    name: str(row.name),
    reason: str(row.reason) ?? '',
    baseRevision,
    currentRevision,
    outdated:
      status === 'pending' &&
      currentRevision !== null &&
      currentRevision !== baseRevision,
    definition,
    diff: proposalDiff(row, agents),
    affectedProjectCount:
      kind === 'update' && template ? await projectCountOf(conn, template) : 0,
    proposedByAgentId: str(row.proposedByAgentId) ?? '',
    proposedByAgentName: agents.get(str(row.proposedByAgentId) ?? '') ?? null,
    sourceRunId: str(row.sourceRunId),
    sourceIssueId: visibleIssue,
    sourceIssueIdentifier: issue ? str(issue.identifier) : null,
    status,
    decidedById,
    decidedByName: decidedById ? (deciders.get(decidedById) ?? null) : null,
    decidedAt: isoOrNull(row.decidedAt),
    comment: str(row.comment),
    resultRevision:
      row.resultRevision === null || row.resultRevision === undefined
        ? null
        : num(row.resultRevision),
    canDecide: context.canDecide && status === 'pending',
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
