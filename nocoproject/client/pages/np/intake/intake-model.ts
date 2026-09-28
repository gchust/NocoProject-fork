import type {
  AgentListItem,
  IntakeDraft,
  IntakeDraftFields,
  IntakeDraftInput,
  IntakeSource,
} from '../types.js';

/**
 * The batch entry table (iteration 2 §E) as pure data: rows in order, each pointing at an earlier row as its parent.
 * Indenting makes a row the child of the nearest earlier sibling; outdenting lifts it to its grandparent; removing a
 * row hands its children to its parent. Positions are renumbered 1…n after every structural change, and the parent
 * pointers follow, so what is sent always satisfies "parentPosition points to a smaller position".
 */

export interface DraftRow {
  /** Stable React key across renumbering. */
  readonly key: string;
  readonly position: number;
  readonly parentPosition: number | null;
  readonly fields: IntakeDraftFields;
  /** The server's validation messages from the last save. */
  readonly serverErrors: readonly string[];
  readonly createdIssueId?: string | null;
}

export const TITLE_MAX = 200;

let keySeed = 0;
function nextKey(): string {
  keySeed += 1;
  return `row-${keySeed}`;
}

/** Renumbers positions 1…n in the current order and rewrites parent pointers to match. */
export function renumber(rows: readonly DraftRow[]): DraftRow[] {
  const map = new Map<number, number>();
  rows.forEach((row, index) => map.set(row.position, index + 1));
  return rows.map((row, index) => {
    const parent =
      row.parentPosition === null
        ? null
        : (map.get(row.parentPosition) ?? null);
    return {
      ...row,
      position: index + 1,
      parentPosition: parent !== null && parent < index + 1 ? parent : null,
    };
  });
}

export function rowsFromDrafts(drafts: readonly IntakeDraft[]): DraftRow[] {
  return renumber(
    [...drafts]
      .sort((a, b) => a.position - b.position)
      .map((draft) => ({
        key: nextKey(),
        position: draft.position,
        parentPosition: draft.parentPosition,
        fields: draft.fields,
        serverErrors: draft.validation?.errors ?? [],
        createdIssueId: draft.createdIssueId ?? null,
      })),
  );
}

export function draftInputs(rows: readonly DraftRow[]): IntakeDraftInput[] {
  return rows.map((row) => ({
    position: row.position,
    parentPosition: row.parentPosition,
    fields: row.fields,
  }));
}

/** How many ancestors a row has (0 for a top-level row); a broken chain stops counting. */
export function depthOf(rows: readonly DraftRow[], index: number): number {
  const byPosition = new Map(rows.map((row) => [row.position, row]));
  let depth = 0;
  let current = rows[index];
  const seen = new Set<number>();
  while (current?.parentPosition !== null && current !== undefined) {
    if (seen.has(current.position)) break;
    seen.add(current.position);
    const parent = byPosition.get(current.parentPosition);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

/** The nearest earlier row with the same parent, which indenting would make this row's parent. */
function previousSibling(
  rows: readonly DraftRow[],
  index: number,
): DraftRow | null {
  const row = rows[index];
  for (let at = index - 1; at >= 0; at -= 1) {
    if (rows[at].parentPosition === row.parentPosition) return rows[at];
    if (rows[at].position === row.parentPosition) return null;
  }
  return null;
}

export function canIndent(rows: readonly DraftRow[], index: number): boolean {
  return index > 0 && previousSibling(rows, index) !== null;
}

export function indentRow(
  rows: readonly DraftRow[],
  index: number,
): DraftRow[] {
  const sibling = previousSibling(rows, index);
  if (!sibling) return [...rows];
  return rows.map((row, at) =>
    at === index ? { ...row, parentPosition: sibling.position } : row,
  );
}

export function outdentRow(
  rows: readonly DraftRow[],
  index: number,
): DraftRow[] {
  const row = rows[index];
  if (!row || row.parentPosition === null) return [...rows];
  const parent = rows.find((item) => item.position === row.parentPosition);
  return rows.map((item, at) =>
    at === index
      ? { ...item, parentPosition: parent?.parentPosition ?? null }
      : item,
  );
}

/** Earlier rows only: a descendant always comes later, so none of these can form a cycle. */
export function parentChoices(
  rows: readonly DraftRow[],
  index: number,
): DraftRow[] {
  return rows.slice(0, Math.max(index, 0));
}

export function setParent(
  rows: readonly DraftRow[],
  index: number,
  parentPosition: number | null,
): DraftRow[] {
  const allowed =
    parentPosition === null ||
    parentChoices(rows, index).some((row) => row.position === parentPosition);
  if (!allowed) return [...rows];
  return rows.map((row, at) =>
    at === index ? { ...row, parentPosition } : row,
  );
}

export function updateFields(
  rows: readonly DraftRow[],
  index: number,
  changes: Partial<IntakeDraftFields>,
): DraftRow[] {
  return rows.map((row, at) =>
    at === index ? { ...row, fields: { ...row.fields, ...changes } } : row,
  );
}

export function addRow(rows: readonly DraftRow[]): DraftRow[] {
  return renumber([
    ...rows,
    {
      key: nextKey(),
      position: rows.length + 1,
      parentPosition: null,
      fields: { title: '' },
      serverErrors: [],
    },
  ]);
}

export function removeRow(
  rows: readonly DraftRow[],
  index: number,
): DraftRow[] {
  const removed = rows[index];
  if (!removed) return [...rows];
  return renumber(
    rows
      .filter((_, at) => at !== index)
      .map((row) =>
        row.parentPosition === removed.position
          ? { ...row, parentPosition: removed.parentPosition }
          : row,
      ),
  );
}

export type RowProblem =
  | 'titleRequired'
  | 'titleTooLong'
  | 'parentInvalid'
  | 'stageWithoutParent'
  | 'stageInvalid'
  | 'agentNoAccess';

/**
 * The browser's reading of the §E rules, shown before saving; the server validates again on save and its messages
 * are shown beside these. A batch broken out of an issue (`source: 'issue'`) hangs its top-level rows under that
 * issue, so a stage there is valid without a parent row.
 */
export function rowProblems(
  rows: readonly DraftRow[],
  index: number,
  context: {
    readonly source: IntakeSource;
    readonly agents?: readonly AgentListItem[];
  },
): RowProblem[] {
  const row = rows[index];
  const problems: RowProblem[] = [];
  const title = row.fields.title.trim();
  if (!title) problems.push('titleRequired');
  if (title.length > TITLE_MAX) problems.push('titleTooLong');
  if (
    row.parentPosition !== null &&
    (row.parentPosition >= row.position ||
      !rows.some((item) => item.position === row.parentPosition))
  ) {
    problems.push('parentInvalid');
  }
  const stage = row.fields.stage;
  if (stage !== null && stage !== undefined) {
    if (!Number.isInteger(stage) || stage < 0) problems.push('stageInvalid');
    else if (row.parentPosition === null && context.source !== 'issue') {
      problems.push('stageWithoutParent');
    }
  }
  const executor = row.fields.executor;
  if (executor?.type === 'agent' && executor.id && context.agents) {
    const agent = context.agents.find((item) => item.id === executor.id);
    if (agent && agent.canInvoke === false) problems.push('agentNoAccess');
  }
  return problems;
}

export function hasProblems(
  rows: readonly DraftRow[],
  context: {
    readonly source: IntakeSource;
    readonly agents?: readonly AgentListItem[];
  },
): boolean {
  return rows.some((_, index) => rowProblems(rows, index, context).length > 0);
}

/** Reads the stage input: empty is "no stage", anything else must be a whole number. */
export function parseStage(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d{1,4}$/u.test(trimmed) ? Number(trimmed) : 'invalid';
}

/**
 * NP-78: the row whose issue a batch file will be attached to — the row naming it in `fields.attachmentIds`, else the
 * first row (the server attaches unassigned files to the first issue it creates, so removing a row loses nothing).
 */
export function attachmentHolder(
  rows: readonly DraftRow[],
  fileId: string,
): number {
  const index = rows.findIndex((row) =>
    (row.fields.attachmentIds ?? []).includes(fileId),
  );
  return index === -1 ? 0 : index;
}

/** Moves a batch file to the row at `index` (taking it off every other row). */
export function moveAttachment(
  rows: readonly DraftRow[],
  fileId: string,
  index: number,
): DraftRow[] {
  return rows.map((row, at) => {
    const ids = (row.fields.attachmentIds ?? []).filter((id) => id !== fileId);
    const next = at === index ? [...ids, fileId] : ids;
    const unchanged =
      next.length === (row.fields.attachmentIds ?? []).length &&
      next.every((id) => (row.fields.attachmentIds ?? []).includes(id));
    return unchanged
      ? row
      : { ...row, fields: { ...row.fields, attachmentIds: next } };
  });
}
