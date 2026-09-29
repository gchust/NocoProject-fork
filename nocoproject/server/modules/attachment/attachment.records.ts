/**
 * `npFiles` rows (NP-78). The file columns are written by `@nocobase/app-plugin-file` on upload; NocoProject owns
 * `uploadedById` and `issueId`. The content path mirrors the plugin's `getUrl` (`<accessPath>/<uuid>.<ext>`, no dot
 * when the extension is empty); the route layer prefixes the application's base path.
 */
import type { Conn } from '../shared/db.js';
import { fromJson, iso, num, str } from '../shared/db.js';
import type {
  AgentAttachmentInfo,
  IntakeAttachmentReadStatus,
} from '../shared/protocol.js';

export const FILE_COLLECTION = 'npFiles';
export const FILE_ACCESS_PATH = '/uploads/np';
/** Uploads never attached to an issue are purged after this long. */
export const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export interface FileRow {
  readonly id: string;
  readonly disk: string;
  readonly key: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedById: string | null;
  readonly issueId: string | null;
  /** Set while the file travels with an intake batch (AI draft tab / np.newIssue.tabs.ai). */
  readonly intakeBatchId: string | null;
  /** What the AI intake parser read of the file. */
  readonly intakeReadStatus: IntakeAttachmentReadStatus | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toFileRow(row: Record<string, unknown>): FileRow {
  return {
    id: str(row.id) ?? '',
    disk: str(row.disk) ?? '',
    key: str(row.key) ?? '',
    filename: str(row.filename) ?? '',
    ext: str(row.ext) ?? '',
    mimeType: str(row.mimeType) ?? 'application/octet-stream',
    size: num(row.size),
    uploadedById: str(row.uploadedById),
    issueId: str(row.issueId),
    intakeBatchId: str(row.intakeBatchId),
    intakeReadStatus: fromJson<IntakeAttachmentReadStatus>(
      row.intakeReadStatus,
    ),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function contentPath(file: Pick<FileRow, 'id' | 'ext'>): string {
  return `${FILE_ACCESS_PATH}/${file.ext ? `${file.id}.${file.ext}` : file.id}`;
}

const FILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** File ids are the plugin's lowercase uuids; anything else is never looked up (PostgreSQL would reject it). */
export function isFileId(value: string): boolean {
  return FILE_ID.test(value);
}

/** The uuid a content request names (`<uuid>` or `<uuid>.<ext>`), or null for anything else. */
export function fileIdOfContentName(name: string): string | null {
  const match = /^([^.]+)(?:\.[a-z0-9]{1,32})?$/u.exec(name);
  const id = match?.[1] ?? '';
  return isFileId(id) ? id : null;
}

export async function findFile(
  conn: Conn,
  id: string,
): Promise<FileRow | null> {
  const row = await conn.query
    .selectFrom(FILE_COLLECTION)
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? toFileRow(row) : null;
}

export async function filesOfIssue(
  conn: Conn,
  issueId: string,
): Promise<FileRow[]> {
  const rows = await conn.query
    .selectFrom(FILE_COLLECTION)
    .selectAll()
    .where('issueId', '=', issueId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toFileRow);
}

/** What an agent sees of an issue's attachments (no content access yet). */
export async function agentAttachments(
  conn: Conn,
  issueId: string,
): Promise<AgentAttachmentInfo[]> {
  return (await filesOfIssue(conn, issueId)).map((file) => ({
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.size,
  }));
}
