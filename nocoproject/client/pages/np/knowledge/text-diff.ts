/**
 * A line diff for knowledge proposals (nocosolution/frontend/frontend-standard.md §S2): what the agent's proposed text adds to and
 * removes from the current version. A plain longest-common-subsequence table is enough for documents of a few
 * hundred lines; past `MAX_CELLS` the diff degrades to "everything removed, everything added" rather than freezing
 * the page.
 */
export type DiffOp = 'same' | 'add' | 'del';

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
}

/** A line with its position in the diff, a stable key for rendering. */
export interface NumberedDiffLine extends DiffLine {
  readonly n: number;
}

const MAX_CELLS = 2_000_000;

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/gu, '\n');
  if (normalized === '') return [];
  return normalized.replace(/\n$/u, '').split('\n');
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ op: 'del' as const, text })),
      ...b.map((text) => ({ op: 'add' as const, text })),
    ];
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      lines.push({ op: 'del', text: a[i] });
      i += 1;
    } else {
      lines.push({ op: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) lines.push({ op: 'del', text: a[i++] });
  while (j < b.length) lines.push({ op: 'add', text: b[j++] });
  return lines;
}

/** Added and removed line counts, for the diff's summary line. */
export function diffStats(lines: readonly DiffLine[]): {
  readonly added: number;
  readonly removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === 'add') added += 1;
    else if (line.op === 'del') removed += 1;
  }
  return { added, removed };
}

export type DiffBlock =
  | { readonly kind: 'lines'; readonly lines: readonly NumberedDiffLine[] }
  | { readonly kind: 'gap'; readonly count: number; readonly n: number };

/**
 * Unchanged runs longer than `context * 2` fold into a gap, keeping `context` lines on each side of a change, so a
 * one-line edit in a long document reads at a glance.
 */
export function foldDiff(input: readonly DiffLine[], context = 3): DiffBlock[] {
  const lines: NumberedDiffLine[] = input.map((line, n) => ({ ...line, n }));
  const blocks: DiffBlock[] = [];
  let buffer: NumberedDiffLine[] = [];
  const flush = () => {
    if (buffer.length > 0) blocks.push({ kind: 'lines', lines: buffer });
    buffer = [];
  };
  let index = 0;
  while (index < lines.length) {
    if (lines[index].op !== 'same') {
      buffer.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].op === 'same') end += 1;
    const run = lines.slice(index, end);
    const leading = index === 0;
    const trailing = end === lines.length;
    const keepBefore = leading ? 0 : context;
    const keepAfter = trailing ? 0 : context;
    if (run.length > keepBefore + keepAfter + 1) {
      buffer.push(...run.slice(0, keepBefore));
      flush();
      blocks.push({
        kind: 'gap',
        count: run.length - keepBefore - keepAfter,
        n: run[keepBefore].n,
      });
      buffer.push(...run.slice(run.length - keepAfter));
    } else {
      buffer.push(...run);
    }
    index = end;
  }
  flush();
  return blocks;
}
