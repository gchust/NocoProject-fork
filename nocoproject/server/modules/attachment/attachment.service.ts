/**
 * Issue attachments (NP-78). Files are uploaded through the file plugin's `npFiles:uploadMany` route and start out
 * unattached (`issueId` null, visible only to the uploader). This service attaches them to an issue, lists them,
 * removes them, decides who may read a file's content and purges uploads never attached.
 *
 * | Action                         | Allowed                                                               |
 * | ------------------------------ | --------------------------------------------------------------------- |
 * | List, read content             | whoever can see the issue; an unattached file only its uploader       |
 * | Attach                         | members who can see the issue, only their own unattached files        |
 * | Remove                         | the uploader, the issue owner, the project lead, owner/admin          |
 *
 * Attaching and removing record `attachment_added` / `attachment_removed` activities and push `np:issues` through
 * `issue.changed`. Removing deletes the row, then the stored object best-effort (the plugin only deletes metadata).
 * Agents read an attachment's bytes with `agentContent` (NP-111) after the route checked the run may read the issue.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  canChangeOwner,
  canSeeIssue,
  requireVisibleIssue,
  viewerOf,
  type Viewer,
} from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { now, toDate, unique } from '../shared/db.js';
import { forbidden, invalid, notFound } from '../shared/errors.js';
import type { IssueAttachment } from '../shared/protocol.js';
import {
  ERROR_INVALID_ATTACHMENT,
  MAX_ATTACHMENTS_PER_REQUEST,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { findIssue } from '../issue/issue.records.js';
import {
  contentPath,
  FILE_COLLECTION,
  filesOfIssue,
  findFile,
  isFileId,
  ORPHAN_TTL_MS,
  toFileRow,
  type FileRow,
} from './attachment.records.js';
import { openBatchIds } from './attachment.intake.js';

/** Reads and deletes stored objects; the provider backs it with the Drive manager. */
export interface FileObjectStore {
  remove(disk: string, key: string): Promise<void>;
  /** The object's bytes as a stream; absent when no Drive is configured. */
  open?(disk: string, key: string): Promise<ReadableStream<Uint8Array>>;
}

/** An attachment's content for the agent API: the row (name, type, size) and its bytes. */
export interface AttachmentContent {
  readonly file: FileRow;
  readonly body: ReadableStream<Uint8Array>;
}

export interface AttachmentService {
  list(actor: Actor, issueIdOrKey: string): Promise<IssueAttachment[]>;
  attach(
    actor: Actor,
    issueIdOrKey: string,
    fileIds: unknown,
  ): Promise<IssueAttachment[]>;
  remove(actor: Actor, issueIdOrKey: string, fileId: string): Promise<void>;
  /** Whether the actor may read the file's content (false for a missing file). */
  canRead(actor: Actor, fileId: string): Promise<boolean>;
  /**
   * The content of a file attached to the issue (by id, already checked readable by the caller); 404 for anything
   * else, including a file of another issue or a store that cannot read.
   */
  agentContent(issueId: string, fileId: string): Promise<AttachmentContent>;
  /** Deletes uploads never attached to an issue and older than a day; answers how many. */
  purgeOrphans(at: Date): Promise<number>;
}

export interface AttachmentDeps {
  readonly tx: TxRunner;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly objects: FileObjectStore;
  readonly onObjectError?: (error: unknown) => void;
}

/** The `fileIds` / `attachmentIds` of a request: 1–10 distinct non-empty strings. */
export function validateFileIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    throw invalid('INVALID_FIELD', `${field} must be an array of strings.`);
  const ids: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || item.trim() === '')
      throw invalid('INVALID_FIELD', `${field} must be an array of strings.`);
    if (!isFileId(item.trim()))
      throw invalid(
        ERROR_INVALID_ATTACHMENT,
        `File ${item} is not an unattached upload of yours.`,
      );
    if (!ids.includes(item.trim())) ids.push(item.trim());
  }
  if (ids.length > MAX_ATTACHMENTS_PER_REQUEST)
    throw invalid(
      'INVALID_FIELD',
      `${field} may name at most ${MAX_ATTACHMENTS_PER_REQUEST} files.`,
    );
  return ids;
}

/**
 * Attaches the actor's own unattached uploads to the issue inside the caller's transaction (also used by
 * `POST /np/issues` with `attachmentIds`). Any other id is 400 `INVALID_ATTACHMENT` and nothing is attached.
 */
export async function attachFiles(
  tx: Tx,
  activity: ActivityRecorder,
  actor: Actor,
  issueId: string,
  fileIds: readonly string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const rows = await tx.conn.query
    .selectFrom(FILE_COLLECTION)
    .selectAll()
    .where('id', 'in', [...fileIds])
    .execute();
  const files = rows.map(toFileRow);
  for (const id of fileIds) {
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
  }
  await tx.conn.query
    .updateTable(FILE_COLLECTION)
    .set({ issueId, updatedAt: now() })
    .where('id', 'in', [...fileIds])
    .execute();
  await activity.record(tx.conn, {
    issueId,
    actor,
    action: 'attachment_added',
    details: { filenames: fileIds.map((id) => filenameOf(files, id)) },
  });
  tx.emit({ type: 'issue.changed', issueId });
}

function filenameOf(files: readonly FileRow[], id: string): string {
  return files.find((file) => file.id === id)?.filename ?? '';
}

async function canRemove(
  conn: Conn,
  viewer: Viewer,
  issue: Parameters<typeof canChangeOwner>[2],
  file: FileRow,
): Promise<boolean> {
  if (file.uploadedById === viewer.userId) return true;
  return canChangeOwner(conn, viewer, issue);
}

export function createAttachmentService(
  deps: AttachmentDeps,
): AttachmentService {
  async function views(
    conn: Conn,
    viewer: Viewer,
    issue: Parameters<typeof canChangeOwner>[2],
    files: readonly FileRow[],
  ): Promise<IssueAttachment[]> {
    const names = await deps.users.names(
      conn,
      files.map((file) => file.uploadedById),
    );
    const manager = await canChangeOwner(conn, viewer, issue);
    return files.map((file) => ({
      id: file.id,
      filename: file.filename,
      ext: file.ext,
      mimeType: file.mimeType,
      size: file.size,
      contentUrl: contentPath(file),
      uploadedById: file.uploadedById,
      uploadedByName: file.uploadedById
        ? (names.get(file.uploadedById) ?? null)
        : null,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      canDelete: manager || file.uploadedById === viewer.userId,
    }));
  }

  async function removeObject(file: FileRow): Promise<void> {
    try {
      await deps.objects.remove(file.disk, file.key);
    } catch (error) {
      deps.onObjectError?.(error);
    }
  }

  return {
    async list(actor, issueIdOrKey) {
      const conn = deps.tx.read();
      const viewer = await viewerOf(conn, actor);
      const issue = await requireVisibleIssue(conn, viewer, issueIdOrKey);
      return views(conn, viewer, issue, await filesOfIssue(conn, issue.id));
    },

    async attach(actor, issueIdOrKey, fileIds) {
      const ids = validateFileIds(fileIds, 'fileIds');
      if (ids.length === 0)
        throw invalid('INVALID_FIELD', 'fileIds must not be empty.');
      return deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        const issue = await requireVisibleIssue(tx.conn, viewer, issueIdOrKey);
        await attachFiles(tx, deps.activity, actor, issue.id, ids);
        return views(
          tx.conn,
          viewer,
          issue,
          await filesOfIssue(tx.conn, issue.id),
        );
      });
    },

    async remove(actor, issueIdOrKey, fileId) {
      const removed = await deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        const issue = await requireVisibleIssue(tx.conn, viewer, issueIdOrKey);
        const file = isFileId(fileId) ? await findFile(tx.conn, fileId) : null;
        if (!file || file.issueId !== issue.id) throw notFound('Attachment');
        if (!(await canRemove(tx.conn, viewer, issue, file)))
          throw forbidden(
            'FORBIDDEN',
            'Only the uploader, the issue owner, the project lead or an owner/admin may remove this attachment.',
          );
        await tx.conn.query
          .deleteFrom(FILE_COLLECTION)
          .where('id', '=', file.id)
          .execute();
        await deps.activity.record(tx.conn, {
          issueId: issue.id,
          actor,
          action: 'attachment_removed',
          details: { filename: file.filename },
        });
        tx.emit({ type: 'issue.changed', issueId: issue.id });
        return file;
      });
      await removeObject(removed);
    },

    async canRead(actor, fileId) {
      if (actor.type !== 'user' || !actor.id || !isFileId(fileId)) return false;
      const conn = deps.tx.read();
      const file = await findFile(conn, fileId);
      if (!file) return false;
      if (!file.issueId) return file.uploadedById === actor.id;
      const issue = await findIssue(conn, file.issueId);
      if (!issue) return false;
      return canSeeIssue(conn, await viewerOf(conn, actor), issue);
    },

    async agentContent(issueId, fileId) {
      const file = isFileId(fileId)
        ? await findFile(deps.tx.read(), fileId)
        : null;
      if (!file || file.issueId !== issueId || !deps.objects.open)
        throw notFound('Attachment');
      return { file, body: await deps.objects.open(file.disk, file.key) };
    },

    async purgeOrphans(at) {
      const conn = deps.tx.read();
      // Oldest unattached uploads first; the age is compared here rather than in SQL because SQLite stores the
      // timestamp as text and would compare it with a numeric parameter. Files of an intake batch that is still a
      // draft are not orphans.
      const rows = await conn.query
        .selectFrom(FILE_COLLECTION)
        .selectAll()
        .where('issueId', 'is', null)
        .orderBy('createdAt', 'asc')
        .limit(500)
        .execute();
      const cutoff = at.getTime() - ORPHAN_TTL_MS;
      const candidates = rows
        .map(toFileRow)
        .filter((file) => (toDate(file.createdAt)?.getTime() ?? 0) < cutoff);
      const open = await openBatchIds(
        conn,
        unique(candidates.map((file) => file.intakeBatchId)),
      );
      let purged = 0;
      for (const file of candidates) {
        if (file.intakeBatchId && open.has(file.intakeBatchId)) continue;
        let remove = conn.query
          .deleteFrom(FILE_COLLECTION)
          .where('id', '=', file.id)
          .where('issueId', 'is', null);
        remove = file.intakeBatchId
          ? remove.where('intakeBatchId', '=', file.intakeBatchId)
          : remove.where('intakeBatchId', 'is', null);
        await remove.execute();
        // Attached or claimed by a batch in the meantime: the row survived, so the object stays.
        if (await findFile(conn, file.id)) continue;
        await removeObject(file);
        purged += 1;
      }
      return purged;
    },
  };
}
