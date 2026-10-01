/**
 * NP-214 comment attachments: files hang on a comment (a thread reply too), never in the issue's attachment area.
 *
 * - `attachToComment` runs in the transaction that inserts the comment: the caller's own unattached uploads (a
 *   person's by `uploadedById`, an agent's by the run that uploaded them, `uploadedByRunId`), not in an intake batch,
 *   get the comment's issue and `commentId`. Anything else is 400 `INVALID_ATTACHMENT` and the comment is not written.
 * - `commentAttachments` / `agentCommentAttachments` list the files of a page of comments in one query.
 *
 * A comment's files stay as long as the comment: there is no comment edit or delete yet. When deleting a comment is
 * added, it deletes the comment's rows in its transaction and the stored objects afterwards (like
 * `AttachmentService.remove`); editing a comment changes only its text.
 */
import type { Actor } from '../shared/activity.js';
import type { Conn, Tx } from '../shared/db.js';
import { now } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  AgentAttachmentInfo,
  CommentAttachment,
} from '../shared/protocol.js';
import {
  ERROR_INVALID_ATTACHMENT,
  isInlinePreviewable,
} from '../shared/protocol.js';
import {
  agentAttachmentInfo,
  contentPath,
  FILE_COLLECTION,
  filesOfComments,
  toFileRow,
  type FileRow,
} from './attachment.records.js';

/** Whether the actor uploaded the file: a person by account, an agent by the very run. */
export function uploadedBy(actor: Actor, file: FileRow): boolean {
  if (actor.type === 'agent')
    return (
      !!actor.runId &&
      file.uploadedById === null &&
      file.uploadedByRunId === actor.runId
    );
  return actor.type === 'user' && !!actor.id && file.uploadedById === actor.id;
}

/**
 * Attaches the actor's own unattached uploads (already validated as 1–10 distinct ids) to a new comment of
 * `issueId`, inside the caller's transaction. Answers how many were attached.
 */
export async function attachToComment(
  tx: Tx,
  actor: Actor,
  issueId: string,
  commentId: string,
  fileIds: readonly string[],
): Promise<number> {
  if (fileIds.length === 0) return 0;
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
      !uploadedBy(actor, file) ||
      file.issueId !== null ||
      file.commentId !== null ||
      file.intakeBatchId !== null
    )
      throw invalid(
        ERROR_INVALID_ATTACHMENT,
        `File ${id} is not an unattached upload of yours.`,
      );
  }
  await tx.conn.query
    .updateTable(FILE_COLLECTION)
    .set({ issueId, commentId, updatedAt: now() })
    .where('id', 'in', [...fileIds])
    .where('issueId', 'is', null)
    .execute();
  // A concurrent request attached one of them first: fail the whole comment rather than drop the file silently.
  const attached = await tx.conn.query
    .selectFrom(FILE_COLLECTION)
    .select('id')
    .where('id', 'in', [...fileIds])
    .where('commentId', '=', commentId)
    .execute();
  if (attached.length !== fileIds.length)
    throw invalid(
      ERROR_INVALID_ATTACHMENT,
      'A file was attached elsewhere in the meantime.',
    );
  return fileIds.length;
}

/** The browser view of each comment's files; `contentUrl` gets `basePath` (the application's base path). */
export async function commentAttachments(
  conn: Conn,
  commentIds: readonly string[],
  basePath: string,
): Promise<Map<string, CommentAttachment[]>> {
  const base = basePath.replace(/\/+$/u, '');
  const result = new Map<string, CommentAttachment[]>();
  for (const [commentId, files] of await filesOfComments(conn, commentIds))
    result.set(
      commentId,
      files.map((file) => ({
        id: file.id,
        filename: file.filename,
        ext: file.ext,
        mimeType: file.mimeType,
        size: file.size,
        contentUrl: `${base}${contentPath(file)}`,
        previewable: isInlinePreviewable(file.mimeType, file.ext),
      })),
    );
  return result;
}

/** The agent view of each comment's files (downloaded with the NP-111 content route). */
export async function agentCommentAttachments(
  conn: Conn,
  commentIds: readonly string[],
): Promise<Map<string, AgentAttachmentInfo[]>> {
  const result = new Map<string, AgentAttachmentInfo[]>();
  for (const [commentId, files] of await filesOfComments(conn, commentIds))
    result.set(commentId, files.map(agentAttachmentInfo));
  return result;
}
