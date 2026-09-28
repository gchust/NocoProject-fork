/**
 * The heuristic intake parser (docs/phase1/iteration-2-contract.md §E). Pure: no database, no clock, no randomness.
 *
 * Rules (each covered by `tests/logic/np-intake.test.ts`):
 * - A heading line (`#` … `######` followed by a space) is a parent task; the lines under it belong to it.
 * - A list line (`-`, `*`, `+`, `1.`, `1)`, optionally a `[ ]` / `[x]` checkbox) is a task. Indented by two or more
 *   spaces (a tab counts as four), it is a sub-task of the previous non-indented list line (or of the heading when
 *   there is none); otherwise it is a sub-task of the current heading, or top-level.
 * - A plain line right after a task (no blank line between) adds to that task's description.
 * - Plain paragraphs separated by blank lines are one task each: the first line is the title, the rest the
 *   description; under a heading they are its sub-tasks.
 * - Markers in a title: `[urgent]` `[high]` `[medium]` `[low]` (case-insensitive) or a standalone `!!` (urgent) /
 *   `!` (high) set the priority; `#tag` adds a label; `@stage2` / `(stage 2)` set the stage (kept only on
 *   sub-tasks). Markers are removed from the title.
 * - A title longer than 200 characters is cut to 200 and the full text is kept at the top of the description.
 * - CSV: when the first non-empty line has a `title` column, every row is a task read by column (`title`,
 *   `description`, `priority`, `labels` separated by `;` or `|`, `stage`, `parent` = the title of an earlier row).
 */
import type {
  IntakeDraftFields,
  IntakeDraftInput,
  IssuePriority,
} from '../shared/protocol.js';
import {
  MAX_DRAFTS,
  MAX_TITLE_LENGTH,
  type IntakeParseInput,
  type IntakeParser,
} from './parser.js';

const PRIORITIES: readonly IssuePriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
];
const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/u;
const CHECKBOX = /^\[[ xX]\]\s+/u;

export interface ExtractedTitle {
  readonly title: string;
  readonly priority?: IssuePriority;
  readonly labels: string[];
  readonly stage?: number;
  /** The original text when the title had to be cut. */
  readonly overflow?: string;
}

/** Pulls priority, label and stage markers out of a title line. */
export function extractMarkers(raw: string): ExtractedTitle {
  let text = raw.replace(CHECKBOX, '');
  let priority: IssuePriority | undefined;
  text = text.replace(
    /\[(urgent|high|medium|low)\]/giu,
    (_match, word: string) => {
      priority ??= word.toLowerCase() as IssuePriority;
      return ' ';
    },
  );
  text = text.replace(
    /(^|\s)(!{1,2})(?=\s|$)/gu,
    (_match, lead: string, bangs: string) => {
      priority ??= bangs.length === 2 ? 'urgent' : 'high';
      return lead;
    },
  );
  let stage: number | undefined;
  text = text.replace(
    /@stage\s*(\d+)|\(stage\s*(\d+)\)/giu,
    (_match, a?: string, b?: string) => {
      stage ??= Number(a ?? b);
      return ' ';
    },
  );
  const labels: string[] = [];
  text = text.replace(
    /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu,
    (_match, lead: string, tag: string) => {
      if (!labels.includes(tag)) labels.push(tag);
      return lead;
    },
  );
  const title = text.replace(/\s+/gu, ' ').trim();
  if (title.length <= MAX_TITLE_LENGTH)
    return { title, priority, labels, stage };
  return {
    title: title.slice(0, MAX_TITLE_LENGTH).trim(),
    priority,
    labels,
    stage,
    overflow: title,
  };
}

interface Row {
  readonly position: number;
  parentPosition: number | null;
  readonly titleLine: string;
  description: string[];
}

function toDraft(row: Row): IntakeDraftInput | null {
  const extracted = extractMarkers(row.titleLine);
  if (!extracted.title) return null;
  const description = [
    ...(extracted.overflow ? [extracted.overflow, ''] : []),
    ...row.description,
  ]
    .join('\n')
    .trim();
  const fields: IntakeDraftFields = {
    title: extracted.title,
    ...(description ? { description } : {}),
    ...(extracted.priority ? { priority: extracted.priority } : {}),
    ...(extracted.labels.length > 0 ? { labels: extracted.labels } : {}),
    ...(extracted.stage !== undefined && row.parentPosition !== null
      ? { stage: extracted.stage }
      : {}),
  };
  return { position: row.position, parentPosition: row.parentPosition, fields };
}

function indentOf(whitespace: string): number {
  return whitespace.replace(/\t/gu, '    ').length;
}

/** Renumbers rows 1..n (skipping rows without a title) and remaps their parents. */
function finish(rows: readonly Row[]): IntakeDraftInput[] {
  const drafts: IntakeDraftInput[] = [];
  const renumbered = new Map<number, number>();
  for (const row of rows) {
    const draft = toDraft(row);
    if (!draft || drafts.length >= MAX_DRAFTS) continue;
    const position = drafts.length + 1;
    renumbered.set(row.position, position);
    drafts.push({
      ...draft,
      position,
      parentPosition:
        draft.parentPosition === null
          ? null
          : (renumbered.get(draft.parentPosition) ?? null),
    });
  }
  return drafts;
}

function parseLines(text: string): IntakeDraftInput[] {
  const rows: Row[] = [];
  let heading: Row | null = null;
  let topItem: Row | null = null;
  let last: Row | null = null;
  let paragraph: string[] = [];
  const add = (titleLine: string, parentPosition: number | null): Row => {
    const row: Row = {
      position: rows.length + 1,
      parentPosition,
      titleLine,
      description: [],
    };
    rows.push(row);
    return row;
  };
  const flush = () => {
    if (paragraph.length === 0) return;
    const row = add(paragraph[0] ?? '', heading?.position ?? null);
    row.description.push(...paragraph.slice(1));
    paragraph = [];
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flush();
      last = null;
      continue;
    }
    const headingMatch = HEADING.exec(line);
    const listMatch = headingMatch ? null : LIST_ITEM.exec(line);
    if (headingMatch) {
      flush();
      heading = add(headingMatch[1] ?? '', null);
      topItem = null;
      last = heading;
    } else if (listMatch) {
      flush();
      const nested = indentOf(listMatch[1] ?? '') >= 2;
      const parent = nested ? (topItem ?? heading) : heading;
      last = add(listMatch[2] ?? '', parent?.position ?? null);
      if (!nested) topItem = last;
    } else if (paragraph.length === 0 && last) {
      last.description.push(line.trim());
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return finish(rows);
}

/** Splits one CSV line (RFC 4180 quoting; no embedded newlines). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function csvHeader(text: string): string[] | null {
  const first = text.split('\n').find((line) => line.trim() !== '');
  if (!first || !first.includes(',')) return null;
  const header = splitCsvLine(first).map((cell) => cell.toLowerCase());
  return header.includes('title') ? header : null;
}

function parseCsv(text: string, header: readonly string[]): IntakeDraftInput[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const column = (cells: readonly string[], name: string) => {
    const index = header.indexOf(name);
    return index >= 0 ? (cells[index] ?? '').trim() : '';
  };
  const drafts: IntakeDraftInput[] = [];
  const byTitle = new Map<string, number>();
  for (const line of lines.slice(1)) {
    if (drafts.length >= MAX_DRAFTS) break;
    const cells = splitCsvLine(line);
    const title = column(cells, 'title').slice(0, MAX_TITLE_LENGTH);
    if (!title) continue;
    const priority = column(cells, 'priority').toLowerCase() as IssuePriority;
    const labels = column(cells, 'labels')
      .split(/[;|]/u)
      .map((label) => label.trim())
      .filter(Boolean);
    const parentPosition =
      byTitle.get(column(cells, 'parent').toLowerCase()) ?? null;
    const stageText = column(cells, 'stage');
    const stage = /^\d+$/u.test(stageText) ? Number(stageText) : undefined;
    const description = column(cells, 'description');
    const position = drafts.length + 1;
    drafts.push({
      position,
      parentPosition,
      fields: {
        title,
        ...(description ? { description } : {}),
        ...(PRIORITIES.includes(priority) || priority === 'none'
          ? { priority }
          : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(stage !== undefined && parentPosition !== null ? { stage } : {}),
      },
    });
    if (!byTitle.has(title.toLowerCase()))
      byTitle.set(title.toLowerCase(), position);
  }
  return drafts;
}

/** Drafts from pasted text, following the rules in the file comment. */
export function parseHeuristically(rawContent: string): IntakeDraftInput[] {
  const text = rawContent.replace(/\r\n?/gu, '\n');
  const header = csvHeader(text);
  return header ? parseCsv(text, header) : parseLines(text);
}

export function createHeuristicIntakeParser(): IntakeParser {
  return {
    kind: 'heuristic',
    parse: async (input: IntakeParseInput) =>
      parseHeuristically(input.rawContent),
  };
}
