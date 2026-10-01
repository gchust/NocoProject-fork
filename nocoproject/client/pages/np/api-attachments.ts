import type { ApiClient } from '@nocobase/app-client';
import type { FileRecord } from '@nocobase/app-plugin-file/client';

/**
 * NP-78 issue attachments (`docs/phase1/protocol-iteration-4.md` §"issue attachments"). Files are uploaded through the file
 * plugin's repository `npFiles` (`uploadOne`, one request per file) and attached with these endpoints. Copied from
 * `server/modules/shared/protocol.phase1-iter4.ts` rather than imported (see `types.ts`).
 */
export interface IssueAttachment {
  readonly id: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentUrl: string;
  readonly uploadedById: string | null;
  readonly uploadedByName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly canDelete: boolean;
}

/**
 * A comment's file (NP-214, `server/modules/shared/protocol.phase2-comment-attachments.ts` `CommentAttachment`).
 * Comment files never appear among the issue's attachments; `previewable` marks the raster images the server serves
 * inline.
 */
export interface CommentAttachment {
  readonly id: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentUrl: string;
  readonly previewable: boolean;
}

/** The file plugin's repository resource for attachments. */
export const ATTACHMENT_RESOURCE = 'npFiles';
/** Mirrors the server defaults (`nocoproject.attachmentMaxFileSize`, `MAX_ATTACHMENTS_PER_REQUEST`). */
export const ATTACHMENT_MAX_FILE_SIZE = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 10;

function id(value: string): string {
  return encodeURIComponent(value);
}

export async function fetchAttachments(
  api: ApiClient,
  issueId: string,
): Promise<IssueAttachment[]> {
  const { data } = await api.request<{ data: IssueAttachment[] }>({
    path: `np/issues/${id(issueId)}/attachments`,
  });
  return data;
}

export async function attachFiles(
  api: ApiClient,
  issueId: string,
  fileIds: readonly string[],
): Promise<IssueAttachment[]> {
  const { data } = await api.request<
    { data: IssueAttachment[] },
    { fileIds: readonly string[] }
  >({
    path: `np/issues/${id(issueId)}/attachments`,
    method: 'POST',
    json: { fileIds },
  });
  return data;
}

export async function removeAttachment(
  api: ApiClient,
  issueId: string,
  fileId: string,
): Promise<void> {
  await api.request({
    path: `np/issues/${id(issueId)}/attachments/${id(fileId)}`,
    method: 'DELETE',
  });
}

/** An attachment as the file components' record (storage fields are not exposed to the browser). */
export function toFileRecord(attachment: IssueAttachment): FileRecord {
  return {
    id: attachment.id,
    disk: '',
    key: '',
    filename: attachment.filename,
    ext: attachment.ext,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
    contentUrl: attachment.contentUrl,
  };
}

/** A comment's file as the file components' record; it carries no times of its own, so the comment's are used. */
export function commentFileRecord(
  attachment: CommentAttachment,
  createdAt: string,
): FileRecord {
  return {
    id: attachment.id,
    disk: '',
    key: '',
    filename: attachment.filename,
    ext: attachment.ext,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt,
    updatedAt: createdAt,
    contentUrl: attachment.contentUrl,
  };
}

/** `1.2 MB`-style size for the attachment list. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
