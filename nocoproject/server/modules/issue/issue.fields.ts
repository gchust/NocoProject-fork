import { hasCapability } from '../agent/capabilities.js';
/**
 * Field validation and change computation for issue writes, including the authorization rules that depend on which
 * field changes (owner, terminal status, agent executor, project, parent). See `shared/authz.ts` for the rule table.
 */
import {
  canChangeOwner,
  canInvokeAgent,
  loadAgentAccess,
  canSeeProject,
  canWriteTerminal,
  forbid,
  requireInvokeAgent,
  requireVisibleIssue,
  type Viewer,
} from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { str } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  ExecutorInput,
  ExecutorType,
  IssueV1,
  IssueV4,
  UpdateIssueRequestV4,
} from '../shared/protocol.js';
import { EXECUTION_MODES } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import {
  stringList,
  validateBoolean,
  validateDate,
  validateStage,
} from '../shared/validate.js';
import { parseUserMentions } from '../collaboration/mentions.js';
import { requireLabels } from '../label/label.service.js';
import type { WorkflowView } from './status.js';
import { findIssue, isIssuePriority } from './issue.records.js';
import { designSkip, processChange } from './process.js';

const MAX_TITLE_LENGTH = 500;
const MAX_PARENT_DEPTH = 50;

export interface ResolvedExecutor {
  readonly executorType: ExecutorType;
  readonly executorId: string | null;
}

export interface ActivityEntry {
  readonly action: string;
  readonly details: Record<string, unknown>;
}

/**
 * The executor of an issue. Iteration 4: a project manager agent (`kind = 'manager'`) only executes project manager
 * conversations and retrospectives (400 `MANAGER_NOT_EXECUTOR` unless `allowConversation`).
 */
export async function resolveExecutor(
  conn: Conn,
  users: UserDirectory,
  input: ExecutorInput,
  options: { readonly allowConversation?: boolean } = {},
): Promise<ResolvedExecutor> {
  if (!input || typeof input !== 'object')
    throw invalid('INVALID_EXECUTOR', 'executor must be { type, id }.');
  if (input.type === 'none') return { executorType: 'none', executorId: null };
  const id = typeof input.id === 'string' ? input.id : '';
  if (!id) throw invalid('INVALID_EXECUTOR', 'executor.id is required.');
  if (input.type === 'agent') {
    const agent = await conn.query
      .selectFrom('agents')
      .select(['id', 'archivedAt', 'kind'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!agent || agent.archivedAt)
      throw invalid('INVALID_EXECUTOR', 'executor agent does not exist.');
    if (agent.kind === 'manager' && !options.allowConversation)
      throw invalid(
        'MANAGER_NOT_EXECUTOR',
        'A project manager type agent does not execute tasks.',
      );
    if (
      !options.allowConversation &&
      !(await hasCapability(conn, id, 'issue.execute'))
    )
      throw invalid(
        'CAPABILITY_DENIED',
        'The agent needs issue.execute to execute issues.',
      );
    return { executorType: 'agent', executorId: id };
  }
  if (input.type === 'user') {
    if (!(await users.exists(conn, id)))
      throw invalid('INVALID_EXECUTOR', 'executor user does not exist.');
    return { executorType: 'user', executorId: id };
  }
  throw invalid(
    'INVALID_EXECUTOR',
    'executor.type must be user, agent or none.',
  );
}

export async function resolveOwner(
  conn: Conn,
  users: UserDirectory,
  ownerUserId: unknown,
): Promise<string | null> {
  if (ownerUserId === null) return null;
  if (
    typeof ownerUserId !== 'string' ||
    !(await users.exists(conn, ownerUserId))
  ) {
    throw invalid('INVALID_OWNER', 'ownerUserId does not exist.');
  }
  return ownerUserId;
}

export function validateTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim() === '')
    throw invalid('INVALID_TITLE', 'title is required.');
  if (title.length > MAX_TITLE_LENGTH)
    throw invalid('INVALID_TITLE', 'title is too long.');
  return title.trim();
}

export function validateStatus(view: WorkflowView, statusKey: unknown): string {
  if (typeof statusKey !== 'string' || !view.isKnown(statusKey)) {
    throw invalid('INVALID_STATUS', 'statusKey is not in the status catalog.');
  }
  return statusKey;
}

/** A project the viewer can see (null clears it). */
export async function resolveProject(
  conn: Conn,
  viewer: Viewer | null,
  projectId: unknown,
): Promise<string | null> {
  if (projectId === null) return null;
  if (typeof projectId !== 'string' || projectId === '')
    throw invalid('INVALID_PROJECT', 'projectId must be a string or null.');
  const exists = await conn.query
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projectId)
    .exists();
  if (!exists || (viewer && !(await canSeeProject(conn, viewer, projectId))))
    throw invalid('INVALID_PROJECT', 'projectId does not exist.');
  return projectId;
}

/**
 * A parent the viewer can see, that is not the issue itself nor one of its descendants (walking up the parent
 * chain of the candidate).
 */
export async function resolveParent(
  conn: Conn,
  viewer: Viewer | null,
  parentIssueId: unknown,
  issueId: string | null,
): Promise<IssueV1 | null> {
  if (parentIssueId === null) return null;
  if (typeof parentIssueId !== 'string' || parentIssueId === '')
    throw invalid('INVALID_PARENT', 'parentIssueId must be a string or null.');
  let parent: IssueV1 | null;
  try {
    parent = viewer
      ? await requireVisibleIssue(conn, viewer, parentIssueId)
      : await findIssue(conn, parentIssueId);
  } catch {
    parent = null;
  }
  if (!parent) throw invalid('INVALID_PARENT', 'parentIssueId does not exist.');
  let cursor: { id: string; parentIssueId: string | null } | null = parent;
  for (let depth = 0; cursor && depth < MAX_PARENT_DEPTH; depth += 1) {
    if (issueId && cursor.id === issueId)
      throw invalid('INVALID_PARENT', 'An issue cannot be its own ancestor.');
    if (!cursor.parentIssueId) return parent;
    const next: Record<string, unknown> | undefined = await conn.query
      .selectFrom('issues')
      .select(['id', 'parentIssueId'])
      .where('id', '=', cursor.parentIssueId)
      .executeTakeFirst();
    cursor = next
      ? { id: String(next.id), parentIssueId: str(next.parentIssueId) }
      : null;
  }
  return parent;
}

export function newMentions(before: string, after: string): string[] {
  const old = new Set(parseUserMentions(before));
  return parseUserMentions(after).filter((id) => !old.has(id));
}

export interface ChangeContext {
  readonly conn: Conn;
  readonly users: UserDirectory;
  readonly viewer: Viewer;
  readonly before: IssueV4;
  /** The workflow of the project the issue ends up in. */
  readonly view: WorkflowView;
}

export interface ComputedChanges {
  readonly values: Record<string, unknown>;
  readonly activities: ActivityEntry[];
  readonly labelIds?: string[];
}

function scalarChange(
  before: IssueV4,
  values: Record<string, unknown>,
  activities: ActivityEntry[],
): (field: keyof IssueV4, action: string, value: unknown) => void {
  return (field, action, value) => {
    if (before[field] === value) return;
    values[field] = value;
    activities.push({ action, details: { from: before[field], to: value } });
  };
}

async function authorizeChanges(
  ctx: ChangeContext,
  values: Record<string, unknown>,
): Promise<void> {
  const { conn, viewer, before, view } = ctx;
  if ('ownerUserId' in values && !(await canChangeOwner(conn, viewer, before)))
    forbid(
      'Only the owner, the project lead or an owner/admin may reassign the owner.',
    );
  if (typeof values.statusKey === 'string') {
    if (!view.canTransition(before.statusKey, values.statusKey, 'user'))
      forbid(
        `Moving from ${before.statusKey} to ${values.statusKey} is not allowed.`,
      );
    // A transition that needs approval may be requested by anyone who can see the issue: the gate decides.
    if (
      view.isTerminal(values.statusKey) &&
      !view.approvalFor(before.statusKey, values.statusKey, 'user') &&
      !(await canWriteTerminal(conn, viewer, before))
    )
      forbid(
        'Only the owner, the project lead or an owner/admin may close an issue.',
      );
  }
  if (values.executorType === 'agent' && typeof values.executorId === 'string')
    await requireInvokeAgent(conn, viewer.userId, values.executorId);
}

/** Phase 0 fields: title, description, status, priority, owner, executor. */
async function coreChanges(
  ctx: ChangeContext,
  patch: UpdateIssueRequestV4,
  values: Record<string, unknown>,
  activities: ActivityEntry[],
): Promise<void> {
  const { conn, users, before, view } = ctx;
  const change = scalarChange(before, values, activities);
  if (patch.title !== undefined)
    change('title', 'title_changed', validateTitle(patch.title));
  if (patch.description !== undefined) {
    if (typeof patch.description !== 'string')
      throw invalid('INVALID_DESCRIPTION', 'description must be a string.');
    if (patch.description !== before.description) {
      values.description = patch.description;
      activities.push({ action: 'description_changed', details: {} });
    }
  }
  if (patch.statusKey !== undefined)
    change(
      'statusKey',
      'status_changed',
      validateStatus(view, patch.statusKey),
    );
  if (patch.priority !== undefined) {
    if (!isIssuePriority(patch.priority))
      throw invalid('INVALID_PRIORITY', 'priority is not valid.');
    change('priority', 'priority_changed', patch.priority);
  }
  if (patch.ownerUserId !== undefined)
    change(
      'ownerUserId',
      'owner_changed',
      await resolveOwner(conn, users, patch.ownerUserId),
    );
  if (patch.executor !== undefined) {
    const next = await resolveExecutor(conn, users, patch.executor, {
      allowConversation: before.originType === 'pm',
    });
    if (
      next.executorType !== before.executorType ||
      next.executorId !== before.executorId
    ) {
      values.executorType = next.executorType;
      values.executorId = next.executorId;
      activities.push({
        action: 'executor_changed',
        details: {
          from: { type: before.executorType, id: before.executorId },
          to: { type: next.executorType, id: next.executorId },
        },
      });
    }
  }
}

/** Iteration 1 fields: stage, dates, auto-execute, parent, project, labels; iteration 2: executionMode. */
async function phase1Changes(
  ctx: ChangeContext,
  patch: UpdateIssueRequestV4,
  values: Record<string, unknown>,
  activities: ActivityEntry[],
): Promise<string[] | undefined> {
  const { conn, viewer, before } = ctx;
  const change = scalarChange(before, values, activities);
  if (patch.stage !== undefined)
    change('stage', 'stage_changed', validateStage(patch.stage));
  if (patch.startDate !== undefined)
    change(
      'startDate',
      'start_date_changed',
      validateDate(patch.startDate, 'startDate'),
    );
  if (patch.dueDate !== undefined)
    change(
      'dueDate',
      'due_date_changed',
      validateDate(patch.dueDate, 'dueDate'),
    );
  if (patch.autoExecuteSubtasks !== undefined)
    change(
      'autoExecuteSubtasks',
      'auto_execute_changed',
      validateBoolean(patch.autoExecuteSubtasks, 'autoExecuteSubtasks'),
    );
  if (patch.projectId !== undefined)
    change(
      'projectId',
      'project_changed',
      await resolveProject(conn, viewer, patch.projectId),
    );
  if (patch.parentIssueId !== undefined) {
    const parent = await resolveParent(
      conn,
      viewer,
      patch.parentIssueId,
      before.id,
    );
    change('parentIssueId', 'parent_changed', parent?.id ?? null);
  }
  if (patch.executionMode !== undefined) {
    if (!EXECUTION_MODES.includes(patch.executionMode))
      throw invalid(
        'INVALID_EXECUTION_MODE',
        'executionMode must be task or session.',
      );
    change('executionMode', 'execution_mode_changed', patch.executionMode);
  }
  if (patch.labelIds === undefined) return undefined;
  return requireLabels(conn, stringList(patch.labelIds, 'labelIds'));
}

/** Validated column changes for a patch, plus one activity per changed field; enforces the field-level rules. */
export async function computeChanges(
  ctx: ChangeContext,
  patch: UpdateIssueRequestV4,
): Promise<ComputedChanges> {
  const values: Record<string, unknown> = {};
  const activities: ActivityEntry[] = [];
  await coreChanges(ctx, patch, values, activities);
  const labelIds = await phase1Changes(ctx, patch, values, activities);
  processChange(ctx.before, patch.process, values, activities);
  designSkip(ctx.before, values, activities);
  await authorizeChanges(ctx, values);
  // Changing ownership must not hand a private agent to someone who cannot use it.
  if ('ownerUserId' in values) {
    const executorType = values.executorType ?? ctx.before.executorType;
    const executorId = values.executorId ?? ctx.before.executorId;
    if (executorType === 'agent' && typeof executorId === 'string') {
      const agent = await loadAgentAccess(ctx.conn, executorId);
      if (
        !agent ||
        typeof values.ownerUserId !== 'string' ||
        !(await canInvokeAgent(ctx.conn, values.ownerUserId, agent))
      ) {
        values.executorType = 'none';
        values.executorId = null;
        // Report the final change once, including when the request also supplied an executor.
        const index = activities.findIndex(
          (entry) => entry.action === 'executor_changed',
        );
        if (index >= 0) activities.splice(index, 1);
        activities.push({
          action: 'executor_changed',
          details: {
            from: { type: ctx.before.executorType, id: ctx.before.executorId },
            to: { type: 'none', id: null },
            reason: 'ownerCannotInvoke',
          },
        });
      }
    }
  }
  return { values, activities, labelIds };
}
