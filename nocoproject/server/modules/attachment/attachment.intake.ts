/**
 * Attachments of intake batches (NP-78, the AI draft tab / np.newIssue.tabs.ai): files uploaded before parsing travel with the batch
 * (`npFiles.intakeBatchId`) and are attached when it is confirmed — each to the issue created from the draft whose
 * `fields.attachmentIds` names it, any other to the first issue created, so no file is lost when drafts are edited.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import type { Conn, Tx } from '../shared/db.js';
import { now, toJson } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  IntakeAttachmentReadStatus,
  IntakeBatchAttachment,
} from '../shared/protocol.js';
import { ERROR_INVALID_ATTACHMENT } from '../shared/protocol.js';
import {
  contentPath,
  FILE_COLLECTION,
  toFileRow,
  type FileRow,
} from './attachment.records.js';

async function batchFiles(conn: Conn, batchId: string): Promise<FileRow[]> {
  const rows = await conn.query
    .selectFrom(FILE_COLLECTION)
    .selectAll()
    .where('intakeBatchId', '=', batchId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toFileRow);
}

/** The batch's files for its detail view (content paths without the application's base path). */
export async function intakeBatchAttachments(
  conn: Conn,
  batchId: string,
): Promise<IntakeBatchAttachment[]> {
  return (await batchFiles(conn, batchId)).map((file) => ({
    id: file.id,
    filename: file.filename,
    ext: file.ext,
    mimeType: file.mimeType,
    size: file.size,
    contentUrl: contentPath(file),
    issueId: file.issueId,
    readStatus: file.intakeReadStatus,
  }));
}

/**
 * The actor's own uploads that are neither attached nor in a batch, in the order named; any other id is 400
 * `INVALID_ATTACHMENT`. Checked before a file's content is read for the parser, and again when it is claimed.
 */
export async function ownLooseFiles(
  conn: Conn,
  actor: Actor,
  fileIds: readonly string[],
): Promise<FileRow[]> {
  if (fileIds.length === 0) return [];
  const rows = await conn.query
    .selectFrom(FILE_COLLECTION)
    .selectAll()
    .where('id', 'in', [...fileIds])
    .execute();
  const files = rows.map(toFileRow);
  return fileIds.map((id) => {
    const file = files.find((candidate) => candidate.id === id);
    if (
      !file ||
      file.uploadedById !== actor.id ||
      file.issueId !== null ||
      file.intakeBatchId !== null
    )
      throw invalid(
        ERROR_INVALID_ATTACHMENT,
        `File ${id} is not an unattached upload of yours.`,
      );
    return file;
  });
}

/** Hands the actor's own unattached uploads to a new batch, with what the parser read of each. */
export async function claimFilesForBatch(
  tx: Tx,
  actor: Actor,
  batchId: string,
  fileIds: readonly string[],
  readStatuses: ReadonlyMap<string, IntakeAttachmentReadStatus> = new Map(),
): Promise<void> {
  await ownLooseFiles(tx.conn, actor, fileIds);
  for (const id of fileIds) {
    const status = readStatuses.get(id);
    await tx.conn.query
      .updateTable(FILE_COLLECTION)
      .set({
        intakeBatchId: batchId,
        intakeReadStatus: toJson(status ?? null),
        updatedAt: now(),
      })
      .where('id', '=', id)
      .execute();
  }
}

export interface ConfirmedDraft {
  readonly issueId: string;
  readonly attachmentIds: readonly string[];
}

/**
 * Attaches the batch's still unattached files to the issues just created from it (`drafts` in creation order);
 * records `attachment_added` on every issue that received some.
 */
export async function attachBatchFiles(
  tx: Tx,
  activity: ActivityRecorder,
  actor: Actor,
  batchId: string,
  drafts: readonly ConfirmedDraft[],
): Promise<void> {
  const first = drafts[0];
  if (!first) return;
  const files = (await batchFiles(tx.conn, batchId)).filter(
    (file) => file.issueId === null,
  );
  const byIssue = new Map<string, FileRow[]>();
  for (const file of files) {
    const target =
      drafts.find((draft) => draft.attachmentIds.includes(file.id)) ?? first;
    byIssue.set(target.issueId, [...(byIssue.get(target.issueId) ?? []), file]);
  }
  for (const [issueId, assigned] of byIssue) {
    await tx.conn.query
      .updateTable(FILE_COLLECTION)
      .set({ issueId, updatedAt: now() })
      .where(
        'id',
        'in',
        assigned.map((file) => file.id),
      )
      .execute();
    await activity.record(tx.conn, {
      issueId,
      actor,
      action: 'attachment_added',
      details: { filenames: assigned.map((file) => file.filename) },
    });
    tx.emit({ type: 'issue.changed', issueId });
  }
}

/** The ids of intake batches still open (their files are not orphans), among `batchIds`. */
export async function openBatchIds(
  conn: Conn,
  batchIds: readonly string[],
): Promise<Set<string>> {
  if (batchIds.length === 0) return new Set();
  const rows = await conn.query
    .selectFrom('intakeBatches')
    .select(['id', 'status'])
    .where('id', 'in', [...batchIds])
    .execute();
  return new Set(
    rows.filter((row) => row.status === 'draft').map((row) => String(row.id)),
  );
}
