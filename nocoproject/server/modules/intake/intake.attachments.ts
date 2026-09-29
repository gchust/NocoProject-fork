/**
 * The AI draft tab's (np.newIssue.tabs.ai) attachments on the way into a batch (NP-78): the uploads are checked to be the member's own
 * loose files before anything is read, their text is extracted for the AI parser (`attachment-text.ts`), and when
 * only the rule-based parser ran on an empty description, one draft named after the first file is produced so the
 * files still land on an issue.
 */
import type { Actor } from '../shared/activity.js';
import type { Conn } from '../shared/db.js';
import type {
  IntakeAttachmentReadStatus,
  IntakeDraftInput,
} from '../shared/protocol.js';
import { ownLooseFiles } from '../attachment/attachment.intake.js';
import type { FileRow } from '../attachment/attachment.records.js';
import type {
  AttachmentTextReader,
  AttachmentTexts,
} from './attachment-text.js';
import { MAX_TITLE_LENGTH } from './parser.js';

export interface IntakeAttachments {
  readonly files: readonly FileRow[];
  /** Null when no reader is configured (the files still travel with the batch). */
  readonly texts: AttachmentTexts | null;
}

export async function readIntakeAttachments(
  reader: AttachmentTextReader | null,
  conn: Conn,
  actor: Actor,
  fileIds: readonly string[],
): Promise<IntakeAttachments> {
  const files = await ownLooseFiles(conn, actor, fileIds);
  if (files.length === 0 || !reader) return { files, texts: null };
  return { files, texts: await reader.read(files) };
}

export function readStatuses(
  attachments: IntakeAttachments,
): ReadonlyMap<string, IntakeAttachmentReadStatus> {
  return attachments.texts?.statuses ?? new Map();
}

/** Whether the files give the parser something to read when the description is empty. */
export function hasReadableText(attachments: IntakeAttachments): boolean {
  return (attachments.texts?.documents.length ?? 0) > 0;
}

/** One draft per the first file's name, for a batch whose parser produced nothing from an empty description. */
export function fileNamedDraft(
  attachments: IntakeAttachments,
): IntakeDraftInput[] {
  const first = attachments.files[0];
  if (!first) return [];
  return [
    {
      position: 1,
      parentPosition: null,
      fields: { title: first.filename.slice(0, MAX_TITLE_LENGTH) },
    },
  ];
}
