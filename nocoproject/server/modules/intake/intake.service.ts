/**
 * Batch intake (docs/phase1/iteration-2-contract.md §E): paste text (or split an issue's description), review the
 * drafts, and confirm them into issues or cancel the batch.
 *
 * A batch belongs to the member who entered it; only they (or an owner/admin) may edit, confirm or cancel it.
 * Confirming creates parents before children (`intake.confirm.ts`). NP-151 removed listing and reverting batches;
 * `reverted` batches and `intake_reverted` activity from before remain readable. Iteration 4: `process` on the
 * request is written into every draft that has none; confirming selects each issue's process (heuristic only,
 * `issue/process.ts`). NP-78: `attachmentIds` hands the member's own uploads to the batch
 * (`attachment/attachment.intake.ts`); they start on the first top-level draft (`fields.attachmentIds`) and are
 * attached when the batch is confirmed.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  canSeeProject,
  requireVisibleIssue,
  viewerOf,
  type Viewer,
} from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { now } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  ConfirmIntakeRequest,
  ConfirmIntakeResponse,
  CreateIntakeBatchRequestV4,
  CreateIntakeBatchResponse,
  IntakeBatch,
  IntakeBatchAiRefineField,
  IntakeBatchAttachmentsField,
  IntakeBatchDetail,
  IntakeDraft,
  IntakeDraftFieldsV4,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import type { SettingsService } from '../system/settings.service.js';
import type { TriggerService } from '../trigger/trigger.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { IssueService } from '../issue/issue.service.js';
import { validateProcess } from '../issue/process.js';
import {
  claimFilesForBatch,
  intakeBatchAttachments,
} from '../attachment/attachment.intake.js';
import { validateFileIds } from '../attachment/attachment.service.js';
import type { AiIntakeParser } from './ai-parser.js';
import type { ProcessClassifier } from './process-classifier.js';
import type { AttachmentTextReader } from '../attachment/attachment-text.js';
import {
  fileNamedDraft,
  hasReadableText,
  readIntakeAttachments,
  readStatuses,
} from './intake.attachments.js';
import { confirmBatch } from './intake.confirm.js';
import { ownBatch, requireStatus, storeDrafts } from './intake.access.js';
import { aiEnabled, parseInput, parseIntake } from './intake.parse.js';
import { refineDrafts } from './intake.refine.js';
import {
  draftsOf,
  findBatch,
  replaceDrafts,
  setBatchStatus,
} from './intake.records.js';
import { validateDrafts } from './intake.validation.js';
import type { IntakeParser } from './parser.js';

const MAX_RAW_CONTENT = 200_000;

/** NP-78: the batch views carry the files that travel with the batch; NP-120: and whether AI may refine it. */
export type IntakeBatchDetailV4 = IntakeBatchDetail &
  IntakeBatchAttachmentsField &
  IntakeBatchAiRefineField;
export type CreateIntakeBatchResponseV4 = CreateIntakeBatchResponse &
  IntakeBatchAttachmentsField &
  IntakeBatchAiRefineField;

export interface IntakeService {
  create(
    actor: Actor,
    input: CreateIntakeBatchRequestV4,
  ): Promise<CreateIntakeBatchResponseV4>;
  get(actor: Actor, id: string): Promise<IntakeBatchDetailV4>;
  putDrafts(actor: Actor, id: string, drafts: unknown): Promise<IntakeDraft[]>;
  /** NP-120: revises the drafts by one instruction (`intake.refine.ts`). */
  refine(actor: Actor, id: string, body: unknown): Promise<IntakeDraft[]>;
  confirm(
    actor: Actor,
    id: string,
    input: ConfirmIntakeRequest,
  ): Promise<ConfirmIntakeResponse>;
  cancel(actor: Actor, id: string): Promise<IntakeBatch>;
}

export interface IntakeDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly settings: SettingsService;
  readonly workflows: WorkflowService;
  readonly issues: () => IssueService;
  readonly triggers: () => TriggerService;
  readonly heuristic: IntakeParser;
  /** Present when the AI employee plugin is registered. */
  readonly ai: AiIntakeParser | null;
  /** True when `ai.llmServices` is not empty. */
  readonly aiConfigured: () => boolean;
  /** Iteration 4: the process of each confirmed draft (heuristic only). */
  readonly classifier: ProcessClassifier;
  /** NP-78: reads attached files for the AI parser; null = files travel with the batch unread. */
  readonly attachmentText: AttachmentTextReader | null;
}

async function source(
  conn: Conn,
  viewer: Viewer,
  input: CreateIntakeBatchRequestV4,
  allowEmpty = false,
): Promise<{
  rawContent: string;
  projectId: string | null;
  sourceIssueId: string | null;
}> {
  if (input?.source === 'issue') {
    if (typeof input.issueId !== 'string' || !input.issueId)
      throw invalid('INVALID_FIELD', 'issueId is required for source issue.');
    const issue = await requireVisibleIssue(conn, viewer, input.issueId);
    return {
      rawContent: issue.description,
      projectId: issue.projectId,
      sourceIssueId: issue.id,
    };
  }
  if (input?.source !== 'paste')
    throw invalid('INVALID_FIELD', 'source must be paste or issue.');
  if (typeof input.rawContent !== 'string')
    throw invalid('INVALID_FIELD', 'rawContent is required.');
  if (!input.rawContent.trim() && !allowEmpty)
    throw invalid(
      'INVALID_FIELD',
      'rawContent is required unless an attached file can be read.',
    );
  if (input.rawContent.length > MAX_RAW_CONTENT)
    throw invalid('INVALID_FIELD', 'rawContent is too long.');
  const projectId = input.projectId ?? null;
  if (projectId !== null) {
    const exists = await conn.query
      .selectFrom('projects')
      .select('id')
      .where('id', '=', projectId)
      .exists();
    if (!exists || !(await canSeeProject(conn, viewer, projectId)))
      throw invalid('INVALID_PROJECT', 'projectId does not exist.');
  }
  return { rawContent: input.rawContent, projectId, sourceIssueId: null };
}

async function create(
  deps: IntakeDeps,
  actor: Actor,
  input: CreateIntakeBatchRequestV4,
): Promise<CreateIntakeBatchResponseV4> {
  const attachmentIds =
    input?.attachmentIds === undefined
      ? []
      : validateFileIds(input.attachmentIds, 'attachmentIds');
  const conn = deps.tx.read();
  const viewer = await viewerOf(conn, actor);
  // NP-78: the files are checked to be the caller's own before any is read, then read for the AI parser.
  const attachments = await readIntakeAttachments(
    deps.attachmentText,
    conn,
    actor,
    attachmentIds,
  );
  const origin = await source(
    conn,
    viewer,
    input,
    hasReadableText(attachments),
  );
  const outcome = await parseIntake(
    deps,
    conn,
    {
      ...(await parseInput(
        conn,
        deps.workflows,
        origin.projectId,
        origin.rawContent,
      )),
      ...(attachments.texts
        ? {
            attachments: {
              documents: attachments.texts.documents,
              unreadNames: attachments.texts.unreadNames,
            },
          }
        : {}),
    },
    viewer.userId,
  );
  const drafts =
    outcome.drafts.length === 0 && !origin.rawContent.trim()
      ? fileNamedDraft(attachments)
      : outcome.drafts;
  const process =
    input?.process === undefined || input.process === null
      ? undefined
      : validateProcess(input.process, true);
  // A batch split from an issue hangs every draft directly under that issue; `process` fills the drafts' gaps.
  const parsed: {
    position: number;
    parentPosition: number | null;
    fields: IntakeDraftFieldsV4;
  }[] = drafts.map((draft) => ({
    ...draft,
    parentPosition: origin.sourceIssueId ? null : draft.parentPosition,
    fields:
      process && !('process' in draft.fields)
        ? { ...draft.fields, process }
        : draft.fields,
  }));
  // NP-78: every uploaded file starts on the first top-level draft; the editor can move it to another one.
  const holder =
    parsed.find((draft) => draft.parentPosition === null) ?? parsed[0];
  if (holder && attachmentIds.length > 0)
    parsed[parsed.indexOf(holder)] = {
      ...holder,
      fields: { ...holder.fields, attachmentIds },
    };
  const id = deps.ids.next();
  await deps.tx.run(async (tx) => {
    const drafts = await validateDrafts(
      {
        conn: tx.conn,
        users: deps.users,
        creatorId: viewer.userId,
        underIssue: !!origin.sourceIssueId,
      },
      parsed,
    );
    const timestamp = now();
    await tx.conn.query
      .insertInto('intakeBatches')
      .values({
        id,
        createdById: viewer.userId,
        projectId: origin.projectId,
        source: origin.sourceIssueId ? 'issue' : 'paste',
        sourceIssueId: origin.sourceIssueId,
        rawContent: origin.rawContent,
        parser: outcome.parser,
        parseError: outcome.parseError,
        status: 'draft',
        aiSessionId: outcome.aiSessionId,
        confirmedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
    await claimFilesForBatch(
      tx,
      actor,
      id,
      attachmentIds,
      readStatuses(attachments),
    );
    await replaceDrafts(tx, deps.ids, id, drafts);
  });
  const read = deps.tx.read();
  return {
    batch: await findBatch(read, id),
    drafts: await draftsOf(read, id),
    parser: outcome.parser,
    attachments: await intakeBatchAttachments(read, id),
    aiRefine: await aiEnabled(deps, read),
  };
}

export function createIntakeService(deps: IntakeDeps): IntakeService {
  return {
    create: (actor, input) => create(deps, actor, input),
    async get(actor, id) {
      const conn = deps.tx.read();
      const { batch } = await ownBatch(conn, actor, id);
      return {
        batch,
        drafts: await draftsOf(conn, id),
        attachments: await intakeBatchAttachments(conn, id),
        aiRefine: await aiEnabled(deps, conn),
      };
    },
    putDrafts: (actor, id, drafts) =>
      deps.tx.run((tx) => storeDrafts(deps, tx, actor, id, drafts)),
    refine: (actor, id, body) => refineDrafts(deps, actor, id, body),
    async confirm(actor, id, input) {
      return deps.tx.run(async (tx) => {
        const { batch } = await ownBatch(tx.conn, actor, id);
        requireStatus(batch, 'draft');
        return confirmBatch(deps, tx, actor, batch, input ?? {});
      });
    },
    async cancel(actor, id) {
      await deps.tx.run(async (tx) => {
        const { batch } = await ownBatch(tx.conn, actor, id);
        requireStatus(batch, 'draft');
        await setBatchStatus(tx, id, 'cancelled');
      });
      return findBatch(deps.tx.read(), id);
    },
  };
}
