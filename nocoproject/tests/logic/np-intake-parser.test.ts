// @vitest-environment node
/**
 * The intake parsers' pure parts (iteration-2 contract §E): every heuristic rule, CSV splitting and the
 * normalization of the AI parser's answer.
 */
import { describe, expect, it } from 'vitest';

import {
  normalizeAiDrafts,
  type IntakeAiResponse,
} from '../../server/modules/intake/ai-parser.ts';
import {
  extractMarkers,
  parseHeuristically,
  splitCsvLine,
} from '../../server/modules/intake/heuristic-parser.ts';
import type { IntakeDraftInput } from '../../server/modules/shared/protocol.ts';

const titles = (drafts: readonly IntakeDraftInput[]) =>
  drafts.map((draft) => draft.fields.title);

describe('heuristic intake parser (pure)', () => {
  it('makes headings parents and list lines their children', () => {
    const drafts = parseHeuristically(
      '# Login\n- Form\n- API\n## Billing\n* Invoices\n',
    );
    expect(
      drafts.map((draft) => [
        draft.position,
        draft.parentPosition,
        draft.fields.title,
      ]),
    ).toEqual([
      [1, null, 'Login'],
      [2, 1, 'Form'],
      [3, 1, 'API'],
      [4, null, 'Billing'],
      [5, 4, 'Invoices'],
    ]);
  });

  it('nests indented list lines under the previous non-indented one', () => {
    const drafts = parseHeuristically(
      '- Parent\n  - Child A\n\t- Child B\n- Next\n 1. Not nested (one space)',
    );
    expect(
      drafts.map((draft) => [draft.fields.title, draft.parentPosition]),
    ).toEqual([
      ['Parent', null],
      ['Child A', 1],
      ['Child B', 1],
      ['Next', null],
      ['Not nested (one space)', null],
    ]);
  });

  it('reads numbered lists and checkboxes', () => {
    expect(
      titles(parseHeuristically('1. One\n2) Two\n- [ ] Three\n- [x] Four')),
    ).toEqual(['One', 'Two', 'Three', 'Four']);
  });

  it('maps priority markers', () => {
    expect(extractMarkers('[Urgent] Fix prod').priority).toBe('urgent');
    expect(extractMarkers('Do this [low]').priority).toBe('low');
    expect(extractMarkers('Fix !! now')).toMatchObject({
      title: 'Fix now',
      priority: 'urgent',
    });
    expect(extractMarkers('! Soon')).toMatchObject({
      title: 'Soon',
      priority: 'high',
    });
    expect(extractMarkers('Hello! world').priority).toBeUndefined();
    expect(extractMarkers('[medium] x !').priority).toBe('medium');
  });

  it('turns #tags into labels and stage markers into stages on sub-tasks only', () => {
    expect(extractMarkers('Build API #backend #api #backend')).toMatchObject({
      title: 'Build API',
      labels: ['backend', 'api'],
    });
    const drafts = parseHeuristically(
      '- Parent @stage1\n  - Step one @stage1\n  - Step two (stage 2) #db',
    );
    expect(drafts[0]?.fields.stage).toBeUndefined();
    expect(drafts[1]?.fields).toMatchObject({ title: 'Step one', stage: 1 });
    expect(drafts[2]?.fields).toMatchObject({
      title: 'Step two',
      stage: 2,
      labels: ['db'],
    });
  });

  it('makes blank-line separated paragraphs one task each, with continuation lines as description', () => {
    const drafts = parseHeuristically(
      'Write the docs\nCover install and upgrade.\n\nShip the release\n\n- Task\n  details are here? no, a list\nmore about task',
    );
    expect(drafts[0]?.fields).toEqual({
      title: 'Write the docs',
      description: 'Cover install and upgrade.',
    });
    expect(drafts[1]?.fields).toEqual({ title: 'Ship the release' });
    expect(drafts.at(-1)?.fields.description).toContain('more about task');
  });

  it('cuts long titles to 200 characters and keeps the full text in the description', () => {
    const long = 'x'.repeat(250);
    const [draft] = parseHeuristically(`- ${long}`);
    expect(draft?.fields.title).toHaveLength(200);
    expect(draft?.fields.description).toBe(long);
  });

  it('reads CSV with a title column', () => {
    expect(splitCsvLine('a,"b, c","d ""q"""')).toEqual(['a', 'b, c', 'd "q"']);
    const drafts = parseHeuristically(
      'title,priority,labels,description,parent,stage\nEpic,high,core;ui,The epic,,\nChild,bogus,,,Epic,2\n,low,,,,\n',
    );
    expect(drafts).toEqual([
      {
        position: 1,
        parentPosition: null,
        fields: {
          title: 'Epic',
          priority: 'high',
          labels: ['core', 'ui'],
          description: 'The epic',
        },
      },
      { position: 2, parentPosition: 1, fields: { title: 'Child', stage: 2 } },
    ]);
  });

  it('normalizes AI drafts: renumbers, drops forward parents and stages without a parent', () => {
    const response: IntakeAiResponse = {
      drafts: [
        { position: 10, parentPosition: null, title: ' Epic ', stage: 1 },
        {
          position: 11,
          parentPosition: 10,
          title: 'Child',
          stage: 2,
          labels: ['a', ' '],
        },
        { position: 12, parentPosition: 99, title: 'Orphan', priority: 'high' },
        { position: 13, parentPosition: null, title: '   ' },
      ],
    };
    expect(normalizeAiDrafts(response)).toEqual([
      { position: 1, parentPosition: null, fields: { title: 'Epic' } },
      {
        position: 2,
        parentPosition: 1,
        fields: { title: 'Child', labels: ['a'], stage: 2 },
      },
      {
        position: 3,
        parentPosition: null,
        fields: { title: 'Orphan', priority: 'high' },
      },
    ]);
  });
});
