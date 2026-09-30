/**
 * Validation and resolution of `POST /np/issues` (moved out of `issue.service.ts` in iteration 4): the checks that
 * need no database, then the values of the new row as the member may set them. Iteration 4 adds `process`
 * (validated here, selected in `process.ts` before the transaction) and refuses a project manager agent as the
 * executor (400 `MANAGER_NOT_EXECUTOR`, in `resolveExecutor`).
 */
import { requireWorkItem } from '../shared/conversation.js';
import { requireInvokeAgent, type Viewer } from '../shared/authz.js';
import type { Tx } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type { CreateIssueRequestV4 } from '../shared/protocol.js';
import { EXECUTION_MODES } from '../shared/protocol.js';
import {
  stringList,
  validateBoolean,
  validateDate,
  validateStage,
} from '../shared/validate.js';
import { requireLabels } from '../label/label.service.js';
import { validateFileIds } from '../attachment/attachment.service.js';
import {
  resolveExecutor,
  resolveOwner,
  resolveParent,
  resolveProject,
  validateStatus,
  validateTitle,
} from './issue.fields.js';
import { isIssuePriority } from './issue.records.js';
import type { IssueDeps, NewIssue } from './issue.service.js';
import { validateProcess } from './process.js';
import { DEFAULT_STATUS } from './status.js';

/** Validation that needs no database (fails before a transaction starts). */
export function validateCreate(input: CreateIssueRequestV4): void {
  validateTitle(input?.title);
  if (input.priority !== undefined && !isIssuePriority(input.priority))
    throw invalid('INVALID_PRIORITY', 'priority is not valid.');
  if (input.description !== undefined && typeof input.description !== 'string')
    throw invalid('INVALID_DESCRIPTION', 'description must be a string.');
  if (input.stage !== undefined) validateStage(input.stage);
  if (input.startDate !== undefined) validateDate(input.startDate, 'startDate');
  if (input.dueDate !== undefined) validateDate(input.dueDate, 'dueDate');
  if (input.autoExecuteSubtasks !== undefined)
    validateBoolean(input.autoExecuteSubtasks, 'autoExecuteSubtasks');
  if (input.blockedBy !== undefined) stringList(input.blockedBy, 'blockedBy');
  if (input.labelIds !== undefined) stringList(input.labelIds, 'labelIds');
  if (input.attachmentIds !== undefined)
    validateFileIds(input.attachmentIds, 'attachmentIds');
  if (
    input.executionMode !== undefined &&
    !EXECUTION_MODES.includes(input.executionMode)
  )
    throw invalid(
      'INVALID_EXECUTION_MODE',
      'executionMode must be task or session.',
    );
  if (input.process !== undefined && input.process !== null)
    validateProcess(input.process, true);
}

/** The values of the new issue (without `process`, which the caller selected before the transaction). */
export async function resolveNewIssue(
  deps: IssueDeps,
  tx: Tx,
  viewer: Viewer,
  input: CreateIssueRequestV4,
): Promise<NewIssue> {
  const conn = tx.conn;
  const parent =
    input.parentIssueId === undefined || input.parentIssueId === null
      ? null
      : await resolveParent(conn, viewer, input.parentIssueId, null);
  // NP-183: a project manager conversation has no sub-issues.
  if (parent) requireWorkItem(parent);
  const projectId =
    input.projectId === undefined
      ? (parent?.projectId ?? null)
      : await resolveProject(conn, viewer, input.projectId);
  const view = await deps.workflows.forProject(conn, projectId);
  const executor = input.executor
    ? await resolveExecutor(conn, deps.users, input.executor)
    : { executorType: 'none' as const, executorId: null };
  if (executor.executorType === 'agent' && executor.executorId)
    await requireInvokeAgent(conn, viewer.userId, executor.executorId);
  const statusKey =
    input.statusKey === undefined
      ? DEFAULT_STATUS
      : validateStatus(view, input.statusKey);
  return {
    title: validateTitle(input.title),
    description: input.description ?? '',
    statusKey,
    priority: input.priority ?? 'none',
    ownerUserId:
      input.ownerUserId === undefined
        ? viewer.userId
        : await resolveOwner(conn, deps.users, input.ownerUserId),
    executor,
    parentIssueId: parent?.id ?? null,
    projectId,
    stage: input.stage === undefined ? null : validateStage(input.stage),
    startDate: validateDate(input.startDate ?? null, 'startDate'),
    dueDate: validateDate(input.dueDate ?? null, 'dueDate'),
    autoExecuteSubtasks:
      input.autoExecuteSubtasks ??
      (await deps.settings.read(conn)).autoExecuteSubtasksDefault,
    labelIds: await requireLabels(
      conn,
      input.labelIds ? stringList(input.labelIds, 'labelIds') : [],
    ),
    createdById: viewer.userId,
    executionMode: input.executionMode ?? 'task',
  };
}
