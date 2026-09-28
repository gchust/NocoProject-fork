/**
 * Opaque keyset cursors for the paginated lists (docs/phase1/iteration-3-contract.md §D).
 *
 * A cursor is base64url JSON `[sortValue, id]` of the last row of a page; the next page continues strictly after it in
 * the list's fixed order (`sortValue`, then `id`). Clients never build or parse one.
 */
import { invalid } from './errors.js';
import { toDate } from './db.js';

export interface CursorKey {
  readonly at: Date;
  readonly id: string;
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}

export function decodeCursor(cursor: string): CursorKey {
  try {
    const [at, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [unknown, unknown];
    const date = toDate(at);
    if (!date || typeof id !== 'string' || !id) throw new Error('bad cursor');
    return { at: date, id };
  } catch {
    throw invalid('INVALID_CURSOR', 'cursor is not valid.');
  }
}

/** A page size within [1, max]; absent → the default. Out-of-range values are clamped. */
export function pageLimit(
  value: number | null | undefined,
  fallback: number,
  max: number,
): number {
  if (value === null || value === undefined) return fallback;
  if (!Number.isInteger(value))
    throw invalid('INVALID_QUERY', 'limit must be an integer.');
  return Math.min(Math.max(value, 1), max);
}
