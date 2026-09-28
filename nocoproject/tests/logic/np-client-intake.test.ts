import { describe, expect, it } from 'vitest';

import { normalizeBatchDetail } from '../../client/pages/np/api-intake.js';
import {
  type DraftRow,
  addRow,
  canIndent,
  depthOf,
  draftInputs,
  hasProblems,
  indentRow,
  outdentRow,
  parentChoices,
  parseStage,
  removeRow,
  rowProblems,
  rowsFromDrafts,
  setParent,
  updateFields,
} from '../../client/pages/np/intake/intake-model.js';
import type {
  AgentListItem,
  IntakeDraft,
} from '../../client/pages/np/types.js';

function drafts(
  spec: readonly (readonly [string, number | null])[],
): IntakeDraft[] {
  return spec.map(([title, parent], index) => ({
    position: index + 1,
    parentPosition: parent,
    fields: { title },
  }));
}

const shape = (rows: readonly DraftRow[]) =>
  rows.map((row) => [row.position, row.parentPosition, row.fields.title]);

describe('intake table: indent to parent', () => {
  it('indenting makes the row a child of the nearest earlier sibling', () => {
    const rows = rowsFromDrafts(
      drafts([
        ['A', null],
        ['B', null],
        ['C', null],
      ]),
    );
    expect(canIndent(rows, 0)).toBe(false);
    const indented = indentRow(rows, 2);
    expect(shape(indented)).toEqual([
      [1, null, 'A'],
      [2, null, 'B'],
      [3, 2, 'C'],
    ]);
    expect(depthOf(indented, 2)).toBe(1);
  });

  it('indents within the same parent, skipping the siblings’ children', () => {
    // A; B (child of A); C (child of A) → indenting C makes it a child of B.
    const rows = rowsFromDrafts(
      drafts([
        ['A', null],
        ['B', 1],
        ['C', 1],
      ]),
    );
    const indented = indentRow(rows, 2);
    expect(indented[2].parentPosition).toBe(2);
    expect(depthOf(indented, 2)).toBe(2);
    // The first child of a parent has no earlier sibling to go under.
    expect(canIndent(rows, 1)).toBe(false);
  });

  it('outdenting lifts the row to its grandparent', () => {
    const rows = rowsFromDrafts(
      drafts([
        ['A', null],
        ['B', 1],
        ['C', 2],
      ]),
    );
    const lifted = outdentRow(rows, 2);
    expect(lifted[2].parentPosition).toBe(1);
    expect(outdentRow(lifted, 0)).toEqual(lifted);
  });

  it('removing a row hands its children to its parent and renumbers', () => {
    const rows = rowsFromDrafts(
      drafts([
        ['A', null],
        ['B', 1],
        ['C', 2],
        ['D', null],
      ]),
    );
    expect(shape(removeRow(rows, 1))).toEqual([
      [1, null, 'A'],
      [2, 1, 'C'],
      [3, null, 'D'],
    ]);
  });

  it('renumbers server positions and follows the parent pointers', () => {
    const rows = rowsFromDrafts([
      { position: 10, parentPosition: null, fields: { title: 'A' } },
      { position: 20, parentPosition: 10, fields: { title: 'B' } },
      {
        position: 30,
        parentPosition: 20,
        fields: { title: 'C' },
        validation: { errors: ['server says no'] },
      },
    ]);
    expect(shape(rows)).toEqual([
      [1, null, 'A'],
      [2, 1, 'B'],
      [3, 2, 'C'],
    ]);
    expect(rows[2].serverErrors).toEqual(['server says no']);
    expect(draftInputs(rows)).toEqual([
      { position: 1, parentPosition: null, fields: { title: 'A' } },
      { position: 2, parentPosition: 1, fields: { title: 'B' } },
      { position: 3, parentPosition: 2, fields: { title: 'C' } },
    ]);
  });

  it('offers only earlier rows as parents and refuses anything else', () => {
    const rows = rowsFromDrafts(
      drafts([
        ['A', null],
        ['B', null],
        ['C', null],
      ]),
    );
    expect(parentChoices(rows, 1).map((row) => row.position)).toEqual([1]);
    expect(setParent(rows, 1, 3)[1].parentPosition).toBeNull();
    expect(setParent(rows, 2, 1)[2].parentPosition).toBe(1);
  });

  it('adds an empty top-level row at the end', () => {
    const rows = addRow(rowsFromDrafts(drafts([['A', null]])));
    expect(shape(rows)).toEqual([
      [1, null, 'A'],
      [2, null, ''],
    ]);
  });
});

describe('intake table: validation', () => {
  const context = { source: 'paste' as const };

  it('requires a title of at most 200 characters', () => {
    const rows = rowsFromDrafts(
      drafts([
        ['', null],
        ['x'.repeat(201), null],
      ]),
    );
    expect(rowProblems(rows, 0, context)).toEqual(['titleRequired']);
    expect(rowProblems(rows, 1, context)).toEqual(['titleTooLong']);
    expect(hasProblems(rows, context)).toBe(true);
  });

  it('accepts a stage only under a parent, except in an issue breakdown', () => {
    let rows = rowsFromDrafts(
      drafts([
        ['A', null],
        ['B', 1],
      ]),
    );
    rows = updateFields(rows, 0, { stage: 1 });
    rows = updateFields(rows, 1, { stage: 2 });
    expect(rowProblems(rows, 0, context)).toEqual(['stageWithoutParent']);
    expect(rowProblems(rows, 1, context)).toEqual([]);
    expect(rowProblems(rows, 0, { source: 'issue' })).toEqual([]);
    rows = updateFields(rows, 1, { stage: Number.NaN });
    expect(rowProblems(rows, 1, context)).toEqual(['stageInvalid']);
  });

  it('flags a parent that is not an earlier row', () => {
    const rows: DraftRow[] = [
      {
        key: 'a',
        position: 1,
        parentPosition: 2,
        fields: { title: 'A' },
        serverErrors: [],
      },
      {
        key: 'b',
        position: 2,
        parentPosition: null,
        fields: { title: 'B' },
        serverErrors: [],
      },
    ];
    expect(rowProblems(rows, 0, context)).toEqual(['parentInvalid']);
  });

  it('flags an agent executor the viewer cannot invoke', () => {
    const agents = [
      {
        id: 'a1',
        name: 'Locked',
        runtimeId: 'r',
        provider: 'echo',
        canInvoke: false,
      },
    ] as AgentListItem[];
    const rows = updateFields(rowsFromDrafts(drafts([['A', null]])), 0, {
      executor: { type: 'agent', id: 'a1' },
    });
    expect(rowProblems(rows, 0, { ...context, agents })).toEqual([
      'agentNoAccess',
    ]);
  });

  it('reads the stage input', () => {
    expect(parseStage('')).toBeNull();
    expect(parseStage(' 2 ')).toBe(2);
    expect(parseStage('two')).toBe('invalid');
    expect(parseStage('-1')).toBe('invalid');
  });
});

describe('intake batch envelope', () => {
  it('accepts { data: { batch, drafts, parser } } and a flat body, ordering drafts', () => {
    const batch = {
      id: 'b1',
      projectId: null,
      source: 'paste',
      parser: 'ai',
      status: 'draft',
      createdAt: '2026-09-27T00:00:00Z',
    };
    const wrapped = normalizeBatchDetail({
      data: {
        batch,
        parser: 'heuristic',
        drafts: [
          { position: 2, parentPosition: null, fields: { title: 'B' } },
          { position: 1, parentPosition: null, fields: { title: 'A' } },
        ],
      },
    });
    expect(wrapped.batch.parser).toBe('heuristic');
    expect(wrapped.drafts.map((draft) => draft.fields.title)).toEqual([
      'A',
      'B',
    ]);
    const flat = normalizeBatchDetail({ ...batch, drafts: [] });
    expect(flat.batch.id).toBe('b1');
    expect(flat.drafts).toEqual([]);
  });
});
