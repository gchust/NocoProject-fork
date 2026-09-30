// @vitest-environment node
/**
 * Pure helpers behind the design pass (nocosolution/guidelines/frontend-standard.md): the knowledge line diff, status tones, the inbox
 * filter / order / keyboard selection, the project's key numbers and the shared inbox cache patch.
 */
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STATUS_CATALOG,
  npKeys,
  statusTone,
} from '../../client/pages/np/constants.js';
import {
  diffStats,
  foldDiff,
  lineDiff,
} from '../../client/pages/np/knowledge/text-diff.js';
import { patchInboxCaches } from '../../client/pages/np/decision/use-decision.js';
import {
  orderDecisions,
  readInboxFilter,
  stepSelection,
} from '../../client/pages/np/inbox/inbox-model.js';
import { projectNumbers } from '../../client/pages/np/projects/progress.js';
import type {
  InboxItem,
  StatusCatalogEntry,
} from '../../client/pages/np/types.js';

const NOW = '2026-09-27T10:00:00.000Z';

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: 'n1',
    kind: 'decision',
    type: 'review_requested',
    issueId: '1',
    issueIdentifier: 'NP-1',
    title: 'NP-1',
    body: null,
    actorType: 'agent',
    actorName: 'Echo',
    count: 1,
    readAt: null,
    archivedAt: null,
    resolvedAt: null,
    payload: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as InboxItem;
}

describe('knowledge line diff', () => {
  it('marks added and removed lines around the unchanged ones', () => {
    const lines = lineDiff('a\nb\nc\n', 'a\nB\nc\nd');
    expect(lines).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'same', text: 'c' },
      { op: 'add', text: 'd' },
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
    expect(lineDiff('', 'x')).toEqual([{ op: 'add', text: 'x' }]);
    expect(diffStats(lineDiff('same\r\ntext', 'same\ntext'))).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it('folds long unchanged runs, keeping context around each change', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const blocks = foldDiff(lineDiff(before, after), 2);
    expect(blocks.map((block) => block.kind)).toEqual(['gap', 'lines', 'gap']);
    const [head, middle, tail] = blocks;
    expect(head).toEqual({ kind: 'gap', count: 8, n: 0 });
    expect(middle.kind === 'lines' && middle.lines.map((l) => l.text)).toEqual([
      'line 8',
      'line 9',
      'line 10',
      'line ten',
      'line 11',
      'line 12',
    ]);
    expect(tail).toMatchObject({ kind: 'gap', count: 7 });
  });
});

describe('status tones', () => {
  it('reads by meaning: grey, blue, violet, amber, green, slate', () => {
    const tones = DEFAULT_STATUS_CATALOG.map((entry) => [
      entry.key,
      statusTone(entry.key),
    ]);
    expect(Object.fromEntries(tones)).toEqual({
      backlog: 'grey',
      todo: 'grey',
      analysis: 'blue',
      proposal_review: 'violet',
      in_progress: 'blue',
      in_review: 'violet',
      blocked: 'amber',
      done: 'green',
      cancelled: 'slate',
    });
  });

  it('maps a custom started status by the colour its workflow gives it', () => {
    const catalog: StatusCatalogEntry[] = [
      { key: 'qa', category: 'started', agentWritable: true, color: 'purple' },
      { key: 'stuck', category: 'started', agentWritable: true, color: 'red' },
      {
        key: 'doing',
        category: 'started',
        agentWritable: true,
        color: 'yellow',
      },
    ];
    expect(statusTone('qa', catalog)).toBe('violet');
    expect(statusTone('stuck', catalog)).toBe('amber');
    expect(statusTone('doing', catalog)).toBe('blue');
  });
});

describe('inbox list model', () => {
  it('defaults the filter to both groups', () => {
    expect(readInboxFilter(null)).toBe('all');
    expect(readInboxFilter('decision')).toBe('decision');
    expect(readInboxFilter('info')).toBe('info');
    expect(readInboxFilter('nope')).toBe('all');
  });

  it('puts waiting decisions before settled ones, keeping the order inside each', () => {
    const ordered = orderDecisions([
      item({ id: 'a', resolvedAt: NOW }),
      item({ id: 'b' }),
      item({ id: 'c', resolvedAt: NOW }),
      item({ id: 'd' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('steps the selection for j / k and clamps at the ends', () => {
    const ids = ['a', 'b', 'c'];
    expect(stepSelection(ids, null, 1)).toBe('a');
    expect(stepSelection(ids, 'a', 1)).toBe('b');
    expect(stepSelection(ids, 'c', 1)).toBe('c');
    expect(stepSelection(ids, 'a', -1)).toBe('a');
    expect(stepSelection(ids, 'gone', -1)).toBe('a');
    expect(stepSelection([], 'a', 1)).toBeNull();
  });

  it('patches an item in every cached inbox list, paged or not', () => {
    const client = new QueryClient();
    client.setQueryData(npKeys.inboxList('decision', false), {
      pages: [{ items: [item({ id: 'n1' }), item({ id: 'n2' })] }],
      pageParams: [null],
    });
    client.setQueryData(npKeys.issueDecisions('1'), {
      items: [item({ id: 'n1' })],
      unread: null,
      nextCursor: null,
    });
    client.setQueryData(npKeys.inboxUnread, { decision: 2, info: 0 });
    patchInboxCaches(client, 'n1', (entry) => ({ ...entry, resolvedAt: NOW }));
    const paged = client.getQueryData<{ pages: { items: InboxItem[] }[] }>(
      npKeys.inboxList('decision', false),
    );
    expect(paged?.pages[0].items.map((entry) => entry.resolvedAt)).toEqual([
      NOW,
      null,
    ]);
    expect(
      client.getQueryData<{ items: InboxItem[] }>(npKeys.issueDecisions('1'))
        ?.items[0].resolvedAt,
    ).toBe(NOW);
    expect(client.getQueryData(npKeys.inboxUnread)).toEqual({
      decision: 2,
      info: 0,
    });
  });
});

describe('project key numbers', () => {
  it('counts totals, work in progress, review and done from the per-status counts', () => {
    expect(
      projectNumbers(
        {
          todo: 3,
          in_progress: 2,
          blocked: 1,
          in_review: 4,
          done: 5,
          cancelled: 1,
        },
        DEFAULT_STATUS_CATALOG,
      ),
    ).toEqual({ total: 16, started: 3, review: 4, done: 5 });
  });
});
