// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { normalizeBoardBody } from '../../client/pages/np/api.js';
import {
  DEFAULT_STATUS_CATALOG,
  catalogFromWorkflow,
} from '../../client/pages/np/constants.js';
import {
  buildBoardColumns,
  isRejectedTransition,
  planBoardMove,
  resolveDropStatus,
} from '../../client/pages/np/issues/board/board-model.js';
import {
  hasIssueFilters,
  readIssueFilters,
  readIssueView,
  readStoredIssueView,
  resolveIssueView,
  storeIssueView,
  withIssueFilter,
  withIssueView,
  withoutIssueFilters,
} from '../../client/pages/np/issues/filters.js';
import { needsStartConfirmation } from '../../client/pages/np/start-confirmation.js';
import type { IssueListItem, Workflow } from '../../client/pages/np/types.js';

const NOW = '2026-09-27T10:00:00.000Z';

function issue(overrides: Partial<IssueListItem>): IssueListItem {
  return {
    id: '1',
    identifier: 'NP-1',
    title: 'Issue',
    statusKey: 'todo',
    priority: 'none',
    ownerUserId: 'u1',
    executorType: 'none',
    executorId: null,
    updatedAt: NOW,
    revision: 1,
    ...overrides,
  };
}

const KNOWN = new Set(DEFAULT_STATUS_CATALOG.map((entry) => entry.key));

describe('confirm start decision', () => {
  const agent = { type: 'agent' as const, id: 'a1' };
  const none = { type: 'none' as const, id: null };

  it('asks when an agent-executed issue leaves backlog for an active status', () => {
    expect(
      needsStartConfirmation({
        fromStatusKey: 'backlog',
        toStatusKey: 'todo',
        executorBefore: agent,
      }),
    ).toBe(true);
  });

  it('does not ask when the move lands in a dormant status or leaves a non-backlog status', () => {
    for (const toStatusKey of ['done', 'cancelled']) {
      expect(
        needsStartConfirmation({
          fromStatusKey: 'backlog',
          toStatusKey,
          executorBefore: agent,
        }),
      ).toBe(false);
    }
    expect(
      needsStartConfirmation({
        fromStatusKey: 'todo',
        toStatusKey: 'in_progress',
        executorBefore: agent,
      }),
    ).toBe(false);
  });

  it('does not ask without an agent executor', () => {
    expect(
      needsStartConfirmation({
        fromStatusKey: 'backlog',
        toStatusKey: 'todo',
        executorBefore: none,
      }),
    ).toBe(false);
    expect(
      needsStartConfirmation({
        fromStatusKey: 'todo',
        executorBefore: agent,
        executorAfter: { type: 'user', id: 'u2' },
      }),
    ).toBe(false);
  });

  it('asks when an agent is assigned to an active issue, but not to a dormant one or the same agent again', () => {
    expect(
      needsStartConfirmation({
        fromStatusKey: 'todo',
        executorBefore: none,
        executorAfter: agent,
      }),
    ).toBe(true);
    expect(
      needsStartConfirmation({
        fromStatusKey: 'todo',
        executorBefore: agent,
        executorAfter: { type: 'agent', id: 'a2' },
      }),
    ).toBe(true);
    expect(
      needsStartConfirmation({
        fromStatusKey: 'backlog',
        executorBefore: none,
        executorAfter: agent,
      }),
    ).toBe(false);
    expect(
      needsStartConfirmation({
        fromStatusKey: 'todo',
        executorBefore: agent,
        executorAfter: agent,
      }),
    ).toBe(false);
  });
});

describe('board move', () => {
  const catalog = DEFAULT_STATUS_CATALOG;

  it('does nothing for a drop on the same column', () => {
    expect(
      planBoardMove(issue({ statusKey: 'todo' }), 'todo', catalog),
    ).toEqual({ kind: 'none' });
  });

  it('patches the status for a plain move', () => {
    expect(
      planBoardMove(issue({ statusKey: 'todo' }), 'in_review', catalog),
    ).toEqual({ kind: 'patch', changes: { statusKey: 'in_review' } });
  });

  it('asks to confirm when the move would start the agent executor', () => {
    expect(
      planBoardMove(
        issue({
          statusKey: 'backlog',
          executorType: 'agent',
          executorId: 'a1',
          executorName: 'Claude Coder',
        }),
        'todo',
        catalog,
      ),
    ).toEqual({
      kind: 'confirm',
      changes: { statusKey: 'todo' },
      agentName: 'Claude Coder',
    });
  });

  it('builds a column per status, applies pending moves and keeps unknown statuses', () => {
    const groups = [
      {
        statusKey: 'todo',
        issues: [issue({ id: '1' }), issue({ id: '2', identifier: 'NP-2' })],
      },
      {
        statusKey: 'triage',
        issues: [issue({ id: '3', statusKey: 'triage' })],
      },
    ];
    const columns = buildBoardColumns(
      catalog,
      groups,
      new Map([['2', 'in_progress']]),
    );
    // The design-first columns stay hidden while no visible issue uses them (iteration 4 §B).
    expect(columns.map((column) => column.statusKey)).toEqual([
      ...catalog
        .map((entry) => entry.key)
        .filter((key) => key !== 'analysis' && key !== 'proposal_review'),
      'triage',
    ]);
    const byKey = new Map(columns.map((column) => [column.statusKey, column]));
    expect(byKey.get('todo')?.issues.map((item) => item.id)).toEqual(['1']);
    expect(byKey.get('in_progress')?.issues.map((item) => item.id)).toEqual([
      '2',
    ]);
    expect(byKey.get('in_progress')?.issues[0].statusKey).toBe('in_progress');
    expect(byKey.get('triage')?.issues).toHaveLength(1);
  });

  it('resolves a drop on a column or on a card inside one', () => {
    const columns = buildBoardColumns(catalog, [
      {
        statusKey: 'blocked',
        issues: [issue({ id: '9', statusKey: 'blocked' })],
      },
    ]);
    expect(resolveDropStatus('column:done', columns)).toBe('done');
    expect(resolveDropStatus('9', columns)).toBe('blocked');
    expect(resolveDropStatus('missing', columns)).toBeNull();
    expect(resolveDropStatus(null, columns)).toBeNull();
  });

  it('treats 403 TRANSITION_NOT_ALLOWED and 409 as a rejected move', () => {
    expect(isRejectedTransition(403, 'TRANSITION_NOT_ALLOWED')).toBe(true);
    expect(isRejectedTransition(409, 'REVISION_CONFLICT')).toBe(true);
    expect(isRejectedTransition(403, 'FORBIDDEN')).toBe(false);
    expect(isRejectedTransition(500, undefined)).toBe(false);
  });

  it('reads the grouped board body in either envelope and groups a flat list', () => {
    const grouped = [{ statusKey: 'todo', issues: [issue({})] }];
    expect(normalizeBoardBody({ data: { groups: grouped } })).toEqual(grouped);
    expect(normalizeBoardBody({ groups: grouped })).toEqual(grouped);
    expect(
      normalizeBoardBody({
        data: [issue({ id: '1' }), issue({ id: '2', statusKey: 'done' })],
      }).map((group) => [group.statusKey, group.issues.length]),
    ).toEqual([
      ['todo', 1],
      ['done', 1],
    ]);
  });

  it('takes board columns from the workflow definition', () => {
    const workflow: Workflow = {
      id: 'w1',
      name: '软件开发',
      isDefault: true,
      definition: {
        statuses: [
          {
            key: 'todo',
            name: 'Todo',
            category: 'unstarted',
            color: 'gray',
            builtIn: true,
          },
          {
            key: 'qa',
            name: 'QA',
            category: 'started',
            color: 'blue',
            builtIn: false,
          },
        ],
        transitions: [],
        childBatchDoneWakesParentExecutor: true,
      },
    };
    expect(catalogFromWorkflow(workflow).map((entry) => entry.key)).toEqual([
      'todo',
      'qa',
    ]);
    expect(catalogFromWorkflow(null)).toBe(DEFAULT_STATUS_CATALOG);
  });
});

describe('issue view preference', () => {
  it('prefers the URL, then the remembered choice, then the board', () => {
    expect(resolveIssueView(new URLSearchParams('view=list'), 'board')).toBe(
      'list',
    );
    expect(resolveIssueView(new URLSearchParams(''), 'list')).toBe('list');
    expect(resolveIssueView(new URLSearchParams(''), null)).toBe('board');
    expect(resolveIssueView(new URLSearchParams('view=odd'), null)).toBe(
      'board',
    );
  });

  it('remembers the choice per page and survives missing or blocked storage', () => {
    // No window at all (this file runs in node): nothing is remembered and nothing throws.
    expect(readStoredIssueView('issues')).toBeNull();
    expect(() => storeIssueView('issues', 'list')).not.toThrow();
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      },
    });
    storeIssueView('issues', 'list');
    expect(readStoredIssueView('issues')).toBe('list');
    expect(readStoredIssueView('my-issues')).toBeNull();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(readStoredIssueView('issues')).toBeNull();
    expect(() => storeIssueView('issues', 'board')).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('issue filters in the query string', () => {
  it('reads the view and filters, dropping unknown statuses and the status filter on the board', () => {
    const list = new URLSearchParams(
      'q=%20claim%20&status=todo&project=p1&label=l1&owner=u1&executor=a1',
    );
    expect(readIssueView(list)).toBe('list');
    expect(readIssueFilters(list, KNOWN)).toEqual({
      q: 'claim',
      statusKey: 'todo',
      projectId: 'p1',
      labelId: 'l1',
      ownerUserId: 'u1',
      executorId: 'a1',
    });
    expect(
      readIssueFilters(new URLSearchParams('status=nope'), KNOWN).statusKey,
    ).toBeUndefined();
    const board = new URLSearchParams('view=board&status=todo&project=p1');
    expect(readIssueView(board)).toBe('board');
    expect(readIssueFilters(board, KNOWN).statusKey).toBeUndefined();
    expect(readIssueFilters(board, KNOWN).projectId).toBe('p1');
  });

  it('sets, clears and resets filters without touching the view', () => {
    let params = new URLSearchParams('view=board');
    params = withIssueFilter(params, 'projectId', 'p1');
    params = withIssueFilter(params, 'labelId', 'l1');
    expect(params.toString()).toBe('view=board&project=p1&label=l1');
    params = withIssueFilter(params, 'labelId', undefined);
    expect(params.toString()).toBe('view=board&project=p1');
    expect(withoutIssueFilters(params).toString()).toBe('view=board');
    // The view is always written out: without it the page falls back to the remembered choice (board by default).
    expect(withIssueView(params, 'list').toString()).toBe(
      'view=list&project=p1',
    );
    expect(hasIssueFilters(readIssueFilters(params, KNOWN))).toBe(true);
    expect(
      hasIssueFilters(readIssueFilters(new URLSearchParams(), KNOWN)),
    ).toBe(false);
  });
});
