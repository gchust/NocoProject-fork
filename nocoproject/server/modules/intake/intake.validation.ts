/**
 * Draft validation for intake batches (docs/phase1/iteration-2-contract.md §E).
 *
 * Structural problems (not an array, positions missing, repeated or not positive integers, more than 500 drafts)
 * reject the whole request with 400 `INVALID_DRAFTS`. Everything else is reported per draft in
 * `validation.errors` (English sentences; the browser shows them as they are) and blocks `confirm`:
 * title required and at most 200 characters; `parentPosition` must name an earlier draft; `stage` only on a draft
 * with a parent (a batch split from an issue gives every draft one); priority in the enum; labels are short
 * strings; an agent executor must be one the member who entered the batch may invoke; users must exist. Iteration 4:
 * `process` is auto, direct or design_first; a project manager agent cannot be the executor. NP-78: `attachmentIds`
 * holds at most 10 file ids (which of them belong to the batch is decided when it is confirmed).
 */
import { canInvokeAgent, loadAgentAccess } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { isArrayValue } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  IntakeDraftFieldsV4,
  IntakeDraftInput,
} from '../shared/protocol.js';
import {
  DEFAULT_PROCESSES,
  MAX_ATTACHMENTS_PER_REQUEST,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { isIssuePriority } from '../issue/issue.records.js';
import { isFileId } from '../attachment/attachment.records.js';
import { MAX_DRAFTS, MAX_TITLE_LENGTH } from './parser.js';

const MAX_LABEL_LENGTH = 64;
const MAX_LABELS = 20;

export interface ValidatedDraft extends IntakeDraftInput {
  readonly errors: string[];
}

export interface DraftContext {
  readonly conn: Conn;
  readonly users: UserDirectory;
  /** The member who entered the batch. */
  readonly creatorId: string;
  /** True when the batch splits an issue: every draft then has a parent. */
  readonly underIssue: boolean;
}

/** The structural check alone (400 `INVALID_DRAFTS`); NP-120's refine runs it before asking the model. */
export function draftStructure(value: unknown): IntakeDraftInput[] {
  if (!isArrayValue(value) || (value as unknown[]).length > MAX_DRAFTS)
    throw invalid(
      'INVALID_DRAFTS',
      `drafts must be an array of at most ${MAX_DRAFTS} drafts.`,
    );
  const seen = new Set<number>();
  return (value as unknown[]).map((item) => {
    const draft = (item ?? {}) as Record<string, unknown>;
    const position = draft.position;
    if (
      !Number.isInteger(position) ||
      (position as number) < 1 ||
      seen.has(position as number)
    )
      throw invalid(
        'INVALID_DRAFTS',
        'Every draft needs a distinct positive integer position.',
      );
    seen.add(position as number);
    const parent = draft.parentPosition ?? null;
    if (parent !== null && !Number.isInteger(parent))
      throw invalid(
        'INVALID_DRAFTS',
        'parentPosition must be an integer or null.',
      );
    const fields = draft.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields))
      throw invalid('INVALID_DRAFTS', 'Every draft needs a fields object.');
    return {
      position: position as number,
      parentPosition: parent as number | null,
      fields: fields as IntakeDraftFieldsV4,
    };
  });
}

function fieldErrors(
  fields: IntakeDraftFieldsV4,
  hasParent: boolean,
): string[] {
  const errors: string[] = [];
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  if (!title) errors.push('title is required');
  else if (title.length > MAX_TITLE_LENGTH)
    errors.push('title is longer than 200 characters');
  if (
    fields.description !== undefined &&
    fields.description !== null &&
    typeof fields.description !== 'string'
  )
    errors.push('description must be text');
  if (fields.priority !== undefined && !isIssuePriority(fields.priority))
    errors.push('priority must be urgent, high, medium, low or none');
  if (fields.labels !== undefined) {
    const labels = fields.labels as unknown;
    if (
      !Array.isArray(labels) ||
      labels.length > MAX_LABELS ||
      labels.some(
        (label) =>
          typeof label !== 'string' ||
          !label.trim() ||
          label.length > MAX_LABEL_LENGTH,
      )
    )
      errors.push('labels must be up to 20 names of at most 64 characters');
  }
  if (fields.stage !== undefined && fields.stage !== null) {
    if (
      !Number.isInteger(fields.stage) ||
      fields.stage < 0 ||
      fields.stage > 1000
    )
      errors.push('stage must be an integer between 0 and 1000');
    else if (!hasParent) errors.push('stage only applies to a sub-task');
  }
  if (
    fields.process !== undefined &&
    !(DEFAULT_PROCESSES as readonly unknown[]).includes(fields.process)
  )
    errors.push('process must be auto, direct or design_first');
  if (fields.attachmentIds !== undefined) {
    const ids = fields.attachmentIds as unknown;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_ATTACHMENTS_PER_REQUEST ||
      ids.some((id) => typeof id !== 'string' || !isFileId(id))
    )
      errors.push('attachmentIds must be up to 10 file ids');
  }
  return errors;
}

async function referenceErrors(
  ctx: DraftContext,
  fields: IntakeDraftFieldsV4,
): Promise<string[]> {
  const errors: string[] = [];
  const executor = fields.executor;
  if (executor && executor.type === 'agent') {
    const agent =
      typeof executor.id === 'string'
        ? await loadAgentAccess(ctx.conn, executor.id)
        : null;
    if (!agent || agent.archivedAt)
      errors.push('the executor agent does not exist');
    else if (!(await canInvokeAgent(ctx.conn, ctx.creatorId, agent)))
      errors.push('you do not have access to the executor agent');
    else if (await isManagerAgent(ctx.conn, agent.id))
      errors.push('a project manager agent cannot execute issues');
  } else if (executor && executor.type === 'user') {
    if (
      typeof executor.id !== 'string' ||
      !(await ctx.users.exists(ctx.conn, executor.id))
    )
      errors.push('the executor user does not exist');
  } else if (executor && executor.type !== 'none') {
    errors.push('executor.type must be user, agent or none');
  }
  if (fields.ownerUserId) {
    if (
      typeof fields.ownerUserId !== 'string' ||
      !(await ctx.users.exists(ctx.conn, fields.ownerUserId))
    )
      errors.push('the owner does not exist');
  }
  return errors;
}

async function isManagerAgent(conn: Conn, agentId: string): Promise<boolean> {
  const row = await conn.query
    .selectFrom('agents')
    .select('kind')
    .where('id', '=', agentId)
    .executeTakeFirst();
  return row?.kind === 'manager';
}

/** Validates a whole draft list; see the file comment for what is structural and what is per draft. */
export async function validateDrafts(
  ctx: DraftContext,
  value: unknown,
): Promise<ValidatedDraft[]> {
  const drafts = draftStructure(value).sort((a, b) => a.position - b.position);
  const positions = new Set(drafts.map((draft) => draft.position));
  const result: ValidatedDraft[] = [];
  for (const draft of drafts) {
    const errors: string[] = [];
    if (draft.parentPosition !== null) {
      if (draft.parentPosition >= draft.position)
        errors.push('parentPosition must point to an earlier draft');
      else if (!positions.has(draft.parentPosition))
        errors.push(`parentPosition ${draft.parentPosition} does not exist`);
    }
    errors.push(
      ...fieldErrors(
        draft.fields,
        ctx.underIssue || draft.parentPosition !== null,
      ),
    );
    errors.push(...(await referenceErrors(ctx, draft.fields)));
    result.push({ ...draft, errors });
  }
  return result;
}
