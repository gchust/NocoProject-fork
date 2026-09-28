/**
 * NP-120: revise a draft batch by one instruction (`POST /np/intake/batches/:id/refine`).
 *
 * The member's current table (unsaved edits included) is the base: the model gets the batch's source text, those drafts
 * and the instruction, and answers the whole revised list. Each revised draft names the draft it came from (`from`)
 * and inherits the fields the model never sees (executor, owner, process, files); the list then replaces the batch's
 * drafts through the same validation as `PUT .../drafts`. The model is asked outside the transaction, and the batch is
 * checked again inside it. There is no heuristic fallback: a failure leaves the drafts untouched.
 */
import type { Actor } from '../shared/activity.js';
import { conflict, invalid, NpError } from '../shared/errors.js';
import type {
  IntakeDraft,
  IntakeDraftFieldsV4,
  IntakeDraftInput,
  RefineIntakeDraftsRequest,
} from '../shared/protocol.js';
import {
  ERROR_AI_REFINE_FAILED,
  ERROR_AI_TIMEOUT,
  ERROR_AI_UNAVAILABLE,
  MAX_REFINE_INSTRUCTION,
} from '../shared/protocol.js';
import { intakeBatchAttachments } from '../attachment/attachment.intake.js';
import { AiTimeoutError } from './ai-parser.js';
import { ownBatch, requireStatus, storeDrafts } from './intake.access.js';
import { aiEnabled, parseInput } from './intake.parse.js';
import type { IntakeDeps } from './intake.service.js';
import { draftStructure } from './intake.validation.js';
import type { RefinedDraft } from './parser.js';

/**
 * Carries over what the model does not manage: a draft with `from` keeps that draft's executor, owner and process;
 * its files go to the first draft taken from it. Files left on no draft move to the first top-level draft. A batch
 * split from an issue stays flat.
 */
export function mergeRefinedDrafts(
  before: readonly IntakeDraftInput[],
  refined: readonly RefinedDraft[],
  underIssue: boolean,
): IntakeDraftInput[] {
  const byPosition = new Map(
    before.map((draft) => [
      draft.position,
      draft.fields as IntakeDraftFieldsV4,
    ]),
  );
  const filesTaken = new Set<number>();
  const merged = refined.map(({ from, ...draft }) => {
    const source = from === null ? undefined : byPosition.get(from);
    const files =
      from !== null && !filesTaken.has(from)
        ? (source?.attachmentIds ?? [])
        : [];
    if (files.length > 0) filesTaken.add(from!);
    const fields: IntakeDraftFieldsV4 = {
      ...draft.fields,
      ...(source?.executor !== undefined ? { executor: source.executor } : {}),
      ...(source?.ownerUserId !== undefined
        ? { ownerUserId: source.ownerUserId }
        : {}),
      ...(source?.process !== undefined ? { process: source.process } : {}),
      ...(files.length > 0 ? { attachmentIds: [...files] } : {}),
    };
    return {
      position: draft.position,
      parentPosition: underIssue ? null : draft.parentPosition,
      fields,
    };
  });
  const placed = new Set(
    merged.flatMap((draft) => draft.fields.attachmentIds ?? []),
  );
  const lost = [
    ...new Set(
      before.flatMap(
        (draft) => (draft.fields as IntakeDraftFieldsV4).attachmentIds ?? [],
      ),
    ),
  ].filter((id) => !placed.has(id));
  const at = Math.max(
    0,
    merged.findIndex((draft) => draft.parentPosition === null),
  );
  const holder = merged[at];
  if (holder && lost.length > 0)
    merged[at] = {
      ...holder,
      fields: {
        ...holder.fields,
        attachmentIds: [...(holder.fields.attachmentIds ?? []), ...lost],
      },
    };
  return merged;
}

function readInstruction(value: unknown): string {
  const instruction = typeof value === 'string' ? value.trim() : '';
  if (!instruction) throw invalid('INVALID_FIELD', 'instruction is required.');
  if (instruction.length > MAX_REFINE_INSTRUCTION)
    throw invalid(
      'INVALID_FIELD',
      `instruction is longer than ${MAX_REFINE_INSTRUCTION} characters.`,
    );
  return instruction;
}

async function askModel(
  deps: IntakeDeps,
  ...args: Parameters<NonNullable<IntakeDeps['ai']>['refineAs']>
): Promise<RefinedDraft[]> {
  let refined: RefinedDraft[];
  try {
    refined = await deps.ai!.refineAs(...args);
  } catch (error) {
    if (error instanceof AiTimeoutError)
      throw new NpError('timeout', ERROR_AI_TIMEOUT, error.message);
    const text = error instanceof Error ? error.message : String(error);
    throw new NpError(
      'upstream',
      ERROR_AI_REFINE_FAILED,
      text.slice(0, 500) || 'The AI failed.',
    );
  }
  if (refined.length === 0)
    throw new NpError(
      'upstream',
      ERROR_AI_REFINE_FAILED,
      'The AI returned no drafts.',
    );
  return refined;
}

export async function refineDrafts(
  deps: IntakeDeps,
  actor: Actor,
  id: string,
  body: unknown,
): Promise<IntakeDraft[]> {
  const request = (body ?? {}) as Partial<RefineIntakeDraftsRequest>;
  const instruction = readInstruction(request.instruction);
  const current = draftStructure(request.drafts).sort(
    (a, b) => a.position - b.position,
  );
  const conn = deps.tx.read();
  const { batch, viewer } = await ownBatch(conn, actor, id);
  requireStatus(batch, 'draft');
  if (!deps.ai || !(await aiEnabled(deps, conn)))
    throw conflict(ERROR_AI_UNAVAILABLE, 'AI is not available for intake.');
  const underIssue = !!batch.sourceIssueId;
  const files = await intakeBatchAttachments(conn, id);
  const refined = await askModel(
    deps,
    {
      ...(await parseInput(
        conn,
        deps.workflows,
        batch.projectId,
        batch.rawContent,
      )),
      drafts: current,
      instruction,
      attachmentNames: files.map((file) => file.filename),
      underIssue,
    },
    viewer.userId,
  );
  const merged = mergeRefinedDrafts(current, refined, underIssue);
  return deps.tx.run((tx) => storeDrafts(deps, tx, actor, id, merged));
}
