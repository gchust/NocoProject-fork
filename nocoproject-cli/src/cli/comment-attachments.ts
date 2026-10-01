/**
 * `issue comment add --attach <path>` (NP-215): files for the new comment. They are checked locally first (each one
 * exists, is a readable regular file, no path twice, at most `MAX_ATTACHMENTS_PER_REQUEST`), then read and uploaded one at a time to
 * `POST /np/agent/issues/:id/uploads` (NP-214) and attached with `attachmentIds`. Any type is accepted; the MIME type
 * comes from the extension, so the server serves screenshots inline. The size limit is the server's (413
 * `ATTACHMENT_TOO_LARGE`). When an upload fails no comment is posted; the server purges the earlier uploads after a day.
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { HttpError, NetworkError } from '../api/client.js';
import { ATTACHMENT_UPLOAD_CAPABILITY, ERROR_ATTACHMENT_TOO_LARGE, INLINE_PREVIEW_TYPES, MAX_ATTACHMENTS_PER_REQUEST } from '../protocol.js';
import { formatSize } from './attachment.js';
import { CliError, EXIT, exitCodeFor } from './output.js';
import type { RunTokenContext } from './run-token.js';

export interface LocalAttachment {
  readonly path: string;
  readonly filename: string;
  readonly size: number;
  readonly mimeType: string;
}

const OTHER_TYPES: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** The MIME type sent for a file: the previewable images by their extension, a few common types, else a binary. */
export function mimeTypeOf(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase();
  const image = Object.entries(INLINE_PREVIEW_TYPES).find(([, exts]) => exts.includes(ext));
  return image?.[0] ?? (Object.hasOwn(OTHER_TYPES, ext) ? OTHER_TYPES[ext]! : 'application/octet-stream');
}

/** Checks the `--attach` paths before anything is uploaded. */
export function localAttachments(paths: readonly string[]): LocalAttachment[] {
  if (paths.length > MAX_ATTACHMENTS_PER_REQUEST)
    throw new CliError(`a comment takes at most ${MAX_ATTACHMENTS_PER_REQUEST} attachments (got ${paths.length})`, EXIT.validation, 'TOO_MANY_ATTACHMENTS');
  const seen = new Set<string>();
  return paths.map((value) => {
    const path = resolve(value);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) throw new CliError(`attachment not found: ${path}`, EXIT.validation, 'FILE_NOT_FOUND');
    if (!stat.isFile()) throw new CliError(`attachment is not a file: ${path}`, EXIT.validation, 'NOT_A_FILE');
    try {
      accessSync(path, constants.R_OK);
    } catch {
      throw new CliError(`attachment is not readable: ${path}`, EXIT.validation, 'FILE_NOT_READABLE');
    }
    const real = realpathSync(path);
    if (seen.has(real)) throw new CliError(`attachment given twice: ${path}`, EXIT.validation, 'DUPLICATE_ATTACHMENT');
    seen.add(real);
    const filename = basename(path);
    return { path, filename, size: stat.size, mimeType: mimeTypeOf(filename) };
  });
}

const NOT_POSTED = 'No comment was posted.';

function uploadError(error: unknown, file: LocalAttachment): unknown {
  // A proxy in front of the server may answer 413 itself, without the code or the limit.
  if (error instanceof HttpError && (error.code === ERROR_ATTACHMENT_TOO_LARGE || error.status === 413)) {
    const max = Number(error.details?.maxFileSize);
    // Sizes that round alike (1.0 MB over 1.0 MB) are shown in bytes.
    const exact = Number.isFinite(max) && formatSize(max) === formatSize(file.size);
    const size = (bytes: number) => (exact ? `${bytes} bytes` : formatSize(bytes));
    const limit = Number.isFinite(max) ? `the server accepts at most ${size(max)}` : 'that is over the server’s limit';
    return new CliError(`attachment too large: ${file.path} is ${size(file.size)}; ${limit}. ${NOT_POSTED}`, EXIT.validation, ERROR_ATTACHMENT_TOO_LARGE, error.details);
  }
  if (error instanceof HttpError && error.code === 'CAPABILITY_DENIED') {
    // A server before NP-214 has no upload route, so its guard names no capability.
    if (error.details?.capability !== ATTACHMENT_UPLOAD_CAPABILITY)
      return new CliError(`this NocoProject server does not accept attachments from agents yet; post the comment without --attach. ${NOT_POSTED}`, EXIT.notFound, 'ATTACHMENT_UPLOAD_UNSUPPORTED');
    return new CliError(
      `this run may not upload attachments (capability ${ATTACHMENT_UPLOAD_CAPABILITY}). An admin grants "Upload comment attachments" to the agent, and a grant applies from its next run; post the comment without --attach meanwhile. ${NOT_POSTED}`,
      EXIT.auth,
      'CAPABILITY_DENIED',
      error.details,
    );
  }
  if (error instanceof NetworkError)
    return new CliError(`uploading ${file.path} (${formatSize(file.size)}) failed: ${error.message}. ${NOT_POSTED}`, EXIT.network, 'NETWORK_ERROR');
  if (error instanceof HttpError)
    return new CliError(`uploading ${file.path} failed: ${error.message}. ${NOT_POSTED}`, exitCodeFor(error), error.code, error.details);
  return error;
}

/** Uploads the files in order and returns their ids for `attachmentIds`. */
export async function uploadAttachments(ctx: RunTokenContext, issueId: string, files: readonly LocalAttachment[]): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    let blob: Blob;
    try {
      // Read whole (within the server's limit): a file still being written is sent as one consistent snapshot.
      blob = new Blob([await readFile(file.path)], { type: file.mimeType });
    } catch (error) {
      throw new CliError(`cannot read attachment ${file.path}: ${(error as Error).message}. ${NOT_POSTED}`, EXIT.validation, 'FILE_NOT_READABLE');
    }
    try {
      ids.push((await ctx.api.upload(issueId, blob, file.filename)).id);
    } catch (error) {
      throw uploadError(error, file);
    }
  }
  return ids;
}
