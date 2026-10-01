/**
 * NocoProject protocol types: comment attachments (NP-214). Files hang on a comment (a thread reply too), never in
 * the issue's attachment area, and any file type is accepted up to `nocoproject.attachmentMaxFileSize`.
 *
 * - Agents upload one file at a time with a run token: `POST /np/agent/issues/:id/uploads` (multipart, field `file`,
 *   capability `attachment.upload`, the run's own issue only) → 201 `{ data: AgentUploadedFile }`. People keep using
 *   `POST /api/npFiles:uploadOne`. Uploads start unattached and are purged after a day.
 * - `POST /np/issues/:id/comments` and `POST /np/agent/issues/:id/comments` take `attachmentIds` (1–10 of the caller's
 *   own unattached uploads; for an agent, uploads of the same run). The comment and its files are written together.
 * - Comments list their files: `CommentV2.attachments` (browser) and `CommentForAgentV2.attachments` (agent API). An
 *   agent downloads one with `GET /np/agent/issues/:id/attachments/:fileId/content` (NP-111).
 * - Browser content (`contentUrl`) is served inline only for the raster images of `INLINE_PREVIEW_TYPES`; every other
 *   file, SVG and HTML included, is a download (`Content-Disposition: attachment`, `nosniff`, `CSP sandbox`).
 * - Attachments are fixed with their comment. Deleting a comment (once it exists) deletes its files; editing a
 *   comment changes only its text.
 *
 * Server source of truth; the CLI copies this file with `pnpm sync-protocol`. This file only imports types from the
 * earlier protocol files. Additive only.
 */
import type { AgentAttachmentInfo } from './protocol.phase1-iter4.js';

export const ATTACHMENT_UPLOAD_CAPABILITY = 'attachment.upload';

/** `POST /np/agent/issues/:id/uploads` → 201 `{ data }`: an unattached upload of this run. */
export type AgentUploadedFile = AgentAttachmentInfo;

/** Addition to `CreateCommentRequest` (browser and agent): 1–10 of the caller's own unattached uploads. */
export interface CreateCommentAttachmentFields {
  readonly attachmentIds?: readonly string[];
}

/** A file of a comment, as the browser sees it. */
export interface CommentAttachment {
  readonly id: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  /** `/uploads/np/<uuid>.<ext>` with the application's base path. */
  readonly contentUrl: string;
  /** A safe raster image: served inline and shown with `<img>`; everything else is a download. */
  readonly previewable: boolean;
}

/** Addition to `CommentV2` (issue detail, comment pages); `[]` for a comment without files. */
export interface CommentAttachmentFields {
  readonly attachments: readonly CommentAttachment[];
}

/** Addition to `CommentForAgentV2` (`GET /np/agent/issues/:id/comments`); `[]` for a comment without files. */
export interface AgentCommentAttachmentFields {
  readonly attachments: readonly AgentAttachmentInfo[];
}

/** The types served inline: MIME type → the extensions it must come with. */
export const INLINE_PREVIEW_TYPES: Readonly<Record<string, readonly string[]>> =
  {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'image/avif': ['avif'],
  };

/**
 * Whether a file is shown inline. The MIME type is what the uploader declared, so it only counts together with a
 * matching extension (both compared in lower case).
 */
export function isInlinePreviewable(mimeType: string, ext: string): boolean {
  const exts = Object.hasOwn(INLINE_PREVIEW_TYPES, mimeType.toLowerCase())
    ? INLINE_PREVIEW_TYPES[mimeType.toLowerCase()]
    : undefined;
  return !!exts && exts.includes(ext.toLowerCase());
}

/** 413: the file is larger than the limit (`details.maxFileSize`, bytes). */
export const ERROR_ATTACHMENT_TOO_LARGE = 'ATTACHMENT_TOO_LARGE';
/** 415: the upload is not `multipart/form-data`. */
export const ERROR_UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE';
/** 400: the multipart body has no single `file`. */
export const ERROR_INVALID_FILE = 'INVALID_FILE';
