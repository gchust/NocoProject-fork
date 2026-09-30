/**
 * Text of the files attached on the AI draft tab (NP-78, np.newIssue.tabs.ai), for the AI intake parser. The configured model reads text
 * only, so documents are turned into text here: plain-text formats are decoded as UTF-8, OOXML / OpenDocument / RTF /
 * PDF go through `officeparser` (the library the AI employee plugin's own document loader uses; the loader itself is
 * not exported). Legacy binary Office files, images and anything else are not read — the model only gets their names.
 *
 * Each file is cut at `PER_FILE_CHARS`, all files together at `TOTAL_CHARS`, and one extraction may take
 * `EXTRACT_TIMEOUT_MS`; the outcome of every file is reported so the drafts view can say what was read.
 */
import { parseOffice } from 'officeparser';

import type {
  AttachmentReadState,
  IntakeAttachmentReadStatus,
} from '../shared/protocol.js';

export const PER_FILE_CHARS = 20_000;
export const TOTAL_CHARS = 60_000;
export const EXTRACT_TIMEOUT_MS = 15_000;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'log',
  'xml',
  'html',
  'htm',
]);
const OFFICE_EXTENSIONS = new Set([
  'docx',
  'pptx',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'rtf',
  'pdf',
]);
const LEGACY_EXTENSIONS = new Set(['doc', 'xls', 'ppt']);

export interface AttachmentSource {
  readonly id: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly disk: string;
  readonly key: string;
}

/** What the parser gets: the files that yielded text, and the names of the others. */
export interface AttachmentTexts {
  readonly documents: readonly {
    readonly filename: string;
    readonly text: string;
    readonly truncated: boolean;
  }[];
  readonly unreadNames: readonly string[];
  /** Per file id, for the batch view. */
  readonly statuses: ReadonlyMap<string, IntakeAttachmentReadStatus>;
}

/** Reads the stored bytes of a file (the provider backs it with Drive). */
export type LoadFileBytes = (disk: string, key: string) => Promise<Uint8Array>;

export interface AttachmentTextReader {
  read(files: readonly AttachmentSource[]): Promise<AttachmentTexts>;
}

type Extracted =
  | { readonly state: 'text'; readonly text: string }
  | { readonly state: Exclude<AttachmentReadState, 'read' | 'truncated'> };

function kindOf(
  file: AttachmentSource,
): 'text' | 'office' | 'legacy' | 'other' {
  const ext = file.ext.toLowerCase();
  if (TEXT_EXTENSIONS.has(ext) || file.mimeType.startsWith('text/'))
    return 'text';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (LEGACY_EXTENSIONS.has(ext)) return 'legacy';
  return 'other';
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Text extraction timed out.')),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Collapses the blank-line runs extraction leaves behind. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

async function extract(
  file: AttachmentSource,
  load: LoadFileBytes,
  timeoutMs: number,
): Promise<Extracted> {
  const kind = kindOf(file);
  if (kind === 'legacy') return { state: 'legacy' };
  if (kind === 'other') return { state: 'unsupported' };
  try {
    const bytes = await withTimeout(load(file.disk, file.key), timeoutMs);
    const text =
      kind === 'text'
        ? new TextDecoder('utf-8').decode(bytes)
        : (
            await withTimeout(
              parseOffice(Buffer.from(bytes), {
                outputErrorToConsole: false,
                extractAttachments: false,
                ocr: false,
              }),
              timeoutMs,
            )
          ).toText();
    const cleaned = tidy(text);
    return cleaned ? { state: 'text', text: cleaned } : { state: 'empty' };
  } catch {
    return { state: 'failed' };
  }
}

export function createAttachmentTextReader(
  load: LoadFileBytes,
  options: {
    readonly perFileChars?: number;
    readonly totalChars?: number;
    readonly timeoutMs?: number;
  } = {},
): AttachmentTextReader {
  const perFile = options.perFileChars ?? PER_FILE_CHARS;
  const total = options.totalChars ?? TOTAL_CHARS;
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  return {
    async read(files) {
      const documents: {
        filename: string;
        text: string;
        truncated: boolean;
      }[] = [];
      const unreadNames: string[] = [];
      const statuses = new Map<string, IntakeAttachmentReadStatus>();
      let budget = total;
      // One file at a time: extraction is CPU-bound and the batch holds at most ten files.
      for (const file of files) {
        const extracted = await extract(file, load, timeoutMs);
        if (extracted.state !== 'text') {
          unreadNames.push(file.filename);
          statuses.set(file.id, { state: extracted.state, chars: 0 });
          continue;
        }
        const limit = Math.min(perFile, budget);
        if (limit <= 0) {
          unreadNames.push(file.filename);
          statuses.set(file.id, { state: 'skipped', chars: 0 });
          continue;
        }
        const truncated = extracted.text.length > limit;
        const text = truncated
          ? extracted.text.slice(0, limit)
          : extracted.text;
        budget -= text.length;
        documents.push({ filename: file.filename, text, truncated });
        statuses.set(file.id, {
          state: truncated ? 'truncated' : 'read',
          chars: text.length,
        });
      }
      return { documents, unreadNames, statuses };
    },
  };
}
