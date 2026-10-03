import { describe, expect, it } from 'vitest';

import {
  isAssistantShortcut,
  isSearchShortcut,
} from '../../client/components/np-shortcut-keys.js';
import {
  clampDrawerWidth,
  drawerStateFromSearch,
  INITIAL_DRAWER_STATE,
  PM_DOCK_QUERY,
  PM_DRAWER_MAX_WIDTH,
  PM_DRAWER_MIN_WIDTH,
  readDrawerState,
  switchTarget,
  withoutDrawerParams,
  writeDrawerState,
} from '../../client/pages/np/pm/assistant/pm-assistant-state.js';
import {
  buildPageContext,
  clampSelection,
  contextChips,
  filterFromSearch,
  parseSourceAttribute,
  PM_CONTEXT_LIMITS,
  type PmContextInput,
} from '../../client/pages/np/pm/context/pm-context-model.js';
import {
  isAgentDown,
  isAgentUnreachable,
  liveTurnView,
  pmMessages,
  referencesIn,
  withAttachmentLinks,
} from '../../client/pages/np/pm/conversation/pm-conversation-model.js';
import {
  canRemove,
  hoursLeft,
  planEdit,
  referencedRefs,
  rowErrorKey,
  rowsToConfirm,
  rowViews,
  updateChanges,
} from '../../client/pages/np/pm/plan/pm-plan-model.js';
import type { IssueComment } from '../../client/pages/np/types.js';
import type { PmPlan, PmPlanRow } from '../../client/pages/np/types-pm.js';

function input(overrides: Partial<PmContextInput> = {}): PmContextInput {
  return {
    route: '/issues/i1',
    pinned: [],
    sources: [],
    filter: null,
    selection: null,
    removed: new Set(),
    ...overrides,
  };
}

describe('page context (protocol-pm-assistant §8.1)', () => {
  it('sends ids only, pinned first, each object once, without removed tags', () => {
    const context = buildPageContext(
      input({
        pinned: [{ type: 'project', id: 'p1', label: 'NocoProject' }],
        sources: [
          { type: 'issue', id: 'i1', label: 'NP-1 A' },
          { type: 'project', id: 'p1', label: 'NocoProject' },
          { type: 'issue', id: 'i2', label: 'NP-2 B' },
        ],
        filter: { page: 'issues', params: { status: 'todo' } },
        selection: { text: 'quoted', sourceType: 'issue', sourceId: 'i1' },
        removed: new Set(['issue:i2', 'filter']),
      }),
    );
    expect(context).toEqual({
      route: '/issues/i1',
      items: [
        { type: 'project', id: 'p1' },
        { type: 'issue', id: 'i1' },
      ],
      selection: { text: 'quoted', sourceType: 'issue', sourceId: 'i1' },
    });
  });

  it('keeps within the limits', () => {
    const sources = Array.from({ length: 15 }, (_, index) => ({
      type: 'issue' as const,
      id: `i${index}`,
      label: `NP-${index}`,
    }));
    const context = buildPageContext(
      input({ route: `/x${'a'.repeat(600)}`, sources }),
    );
    expect(context?.items).toHaveLength(PM_CONTEXT_LIMITS.items);
    expect(context?.route).toHaveLength(PM_CONTEXT_LIMITS.route);
    expect(clampSelection(` ${'z'.repeat(2500)} `)).toHaveLength(
      PM_CONTEXT_LIMITS.selection,
    );
    expect(clampSelection('   ')).toBeNull();
  });

  it('marks pinned objects and hides an empty filter', () => {
    const chips = contextChips(
      input({
        pinned: [{ type: 'issue', id: 'i1', label: 'NP-1' }],
        sources: [{ type: 'issue', id: 'i1', label: 'NP-1' }],
        filter: { page: 'issues', params: {} },
      }),
    );
    expect(chips).toEqual([
      expect.objectContaining({
        key: 'issue:i1',
        kind: 'object',
        pinned: true,
      }),
    ]);
  });

  it('reads a list filter from the listed URL keys only', () => {
    const search = new URLSearchParams(
      'status=todo&status=in_progress&view=board&owner=&q=login',
    );
    expect(filterFromSearch('board', search, ['q', 'status', 'owner'])).toEqual(
      { page: 'board', params: { q: 'login', status: 'todo,in_progress' } },
    );
    expect(
      filterFromSearch('issues', new URLSearchParams('view=list'), ['q']),
    ).toBeNull();
  });

  it('parses the source of a selection', () => {
    expect(parseSourceAttribute('issue:abc')).toEqual({
      sourceType: 'issue',
      sourceId: 'abc',
    });
    expect(parseSourceAttribute('widget:abc')).toBeNull();
    expect(parseSourceAttribute('issue:')).toBeNull();
    expect(parseSourceAttribute(null)).toBeNull();
  });
});

describe('drawer state', () => {
  it('opens from ?pm= and drops its own parameters', () => {
    expect(
      drawerStateFromSearch(
        new URLSearchParams('pm=c1&pmMode=expanded'),
        INITIAL_DRAWER_STATE,
      ),
    ).toEqual({
      open: true,
      mode: 'expanded',
      view: 'chat',
      conversationId: 'c1',
      width: null,
    });
    expect(
      drawerStateFromSearch(new URLSearchParams('pm=new'), INITIAL_DRAWER_STATE)
        ?.conversationId,
    ).toBeNull();
    expect(
      drawerStateFromSearch(
        new URLSearchParams('pm=history'),
        INITIAL_DRAWER_STATE,
      )?.view,
    ).toBe('history');
    expect(
      drawerStateFromSearch(new URLSearchParams('a=1'), INITIAL_DRAWER_STATE),
    ).toBeNull();
    expect(
      withoutDrawerParams(new URLSearchParams('a=1&pm=c1&pmMode=expanded')),
    ).toBe('?a=1');
    expect(withoutDrawerParams(new URLSearchParams('pm=c1'))).toBe('');
  });

  it('survives a reload and ignores a broken value', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage;
    writeDrawerState(
      {
        open: true,
        mode: 'expanded',
        view: 'history',
        conversationId: 'c1',
        width: 500,
      },
      storage,
    );
    expect(readDrawerState(storage)).toEqual({
      open: true,
      mode: 'expanded',
      view: 'history',
      conversationId: 'c1',
      width: 500,
    });
    // A stored width outside the limits is clamped; a non-number is dropped.
    store.set('nocoproject:pm-drawer', '{"open":true,"width":9000}');
    expect(readDrawerState(storage).width).toBe(PM_DRAWER_MAX_WIDTH);
    store.set('nocoproject:pm-drawer', '{"open":true,"width":"wide"}');
    expect(readDrawerState(storage).width).toBeNull();
    store.set('nocoproject:pm-drawer', '{oops');
    expect(readDrawerState(storage)).toEqual(INITIAL_DRAWER_STATE);
  });

  it('keeps the dragged width within its limits', () => {
    expect(clampDrawerWidth(100)).toBe(PM_DRAWER_MIN_WIDTH);
    expect(clampDrawerWidth(9000)).toBe(PM_DRAWER_MAX_WIDTH);
    expect(clampDrawerWidth(480.4)).toBe(480);
    // The drawer docks from 1024px; below that it is the full-screen overlay.
    expect(PM_DOCK_QUERY).toBe('(min-width: 1024px)');
    expect(
      drawerStateFromSearch(new URLSearchParams('pm=c1'), {
        ...INITIAL_DRAWER_STATE,
        width: 500,
      })?.width,
    ).toBe(500);
  });

  it('offers "switch and start a new conversation" only when there is somewhere to go', () => {
    const choice = {
      mode: 'system' as const,
      agentId: 'mine',
      revision: 1,
      allowPersonal: true,
      systemAgent: {
        id: 'sys',
        name: 'PM',
        provider: 'claude',
        model: null,
        online: true,
      },
      candidates: [
        {
          id: 'mine',
          name: 'Mine',
          provider: 'claude',
          model: null,
          runtimeName: null,
          online: true,
        },
      ],
      eligibleRuntimes: [],
    };
    expect(switchTarget(choice, undefined)).toBe('personal');
    expect(
      switchTarget({ ...choice, allowPersonal: false }, undefined),
    ).toBeNull();
    expect(switchTarget({ ...choice, agentId: null }, undefined)).toBeNull();
    expect(switchTarget(undefined, undefined)).toBeNull();
  });

  it('opens with ⌘J / Ctrl+J only', () => {
    const key = (overrides: Partial<KeyboardEvent>) =>
      ({
        key: 'j',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...overrides,
      }) as KeyboardEvent;
    expect(isAssistantShortcut(key({ metaKey: true }))).toBe(true);
    expect(isAssistantShortcut(key({ ctrlKey: true, key: 'J' }))).toBe(true);
    expect(isAssistantShortcut(key({ metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isAssistantShortcut(key({}))).toBe(false);
    expect(isSearchShortcut(key({ metaKey: true }))).toBe(false);
  });
});

describe('conversation model', () => {
  const comment = (overrides: Partial<IssueComment>): IssueComment => ({
    id: 'x',
    authorType: 'user',
    authorId: 'u1',
    content: '',
    parentId: null,
    createdAt: '2026-09-30T00:00:00Z',
    ...overrides,
  });

  it('orders messages and tells plans, results and system lines apart', () => {
    const messages = pmMessages([
      {
        root: comment({
          id: 'b',
          createdAt: '2026-09-30T00:00:02Z',
          kind: 'plan',
          authorType: 'agent',
        }),
        replies: [],
      },
      {
        root: comment({ id: 'a' }),
        replies: [
          comment({
            id: 'r',
            authorType: 'agent',
            createdAt: '2026-09-30T00:00:01Z',
          }),
        ],
      },
      {
        root: comment({
          id: 'c',
          kind: 'plan_result',
          createdAt: '2026-09-30T00:00:03Z',
        }),
        replies: [],
      },
      {
        root: comment({
          id: 'd',
          authorType: 'system',
          createdAt: '2026-09-30T00:00:04Z',
        }),
        replies: [],
      },
    ]);
    expect(
      messages.map((message) => [message.comment.id, message.kind]),
    ).toEqual([
      ['a', 'user'],
      ['r', 'agent'],
      ['b', 'plan'],
      ['c', 'planResult'],
      ['d', 'system'],
    ]);
  });

  it('folds the steps of a turn and streams its text', () => {
    const view = liveTurnView([
      { seq: 1, type: 'thinking', content: 'hmm', at: '' },
      {
        seq: 2,
        type: 'toolUse',
        tool: 'Bash',
        input: { command: 'nocoproject issue get NP-12' },
        at: '',
      },
      { seq: 3, type: 'toolResult', output: '{}', at: '' },
      { seq: 4, type: 'text', content: 'NP-12 is', at: '' },
      { seq: 5, type: 'text', content: 'in review.', at: '' },
    ]);
    expect(view.steps).toHaveLength(3);
    expect(view.current).toBe('$ nocoproject issue get NP-12');
    expect(view.reply).toBe('NP-12 is\n\nin review.');
  });

  it('finds at most five references, skipping code', () => {
    const refs = referencesIn(
      'See NP-12 and [the project](/projects/p9), also `NP-99`, NP-12 again, /knowledge/k1 NP-1 NP-2 NP-3 NP-4',
    );
    expect(refs.map((ref) => ref.key)).toEqual([
      'issue:NP-12',
      'project:p9',
      'knowledgeDoc:k1',
      'issue:NP-1',
      'issue:NP-2',
    ]);
  });

  it('lists attached files under the message', () => {
    expect(
      withAttachmentLinks('Look', [
        { filename: 'a [1].png', contentUrl: '/uploads/a.png' },
      ]),
    ).toBe('Look\n\n- [a 1.png](/uploads/a.png)');
    expect(withAttachmentLinks('Only text', [])).toBe('Only text');
  });

  it('knows when a personal agent cannot answer', () => {
    const agent = {
      id: 'a',
      name: 'A',
      source: 'personal' as const,
      online: true,
      runtimeName: null,
      compat: 'ok' as const,
      personalAvailable: true,
    };
    expect(isAgentUnreachable(agent)).toBe(false);
    expect(isAgentUnreachable({ ...agent, online: false })).toBe(true);
    expect(isAgentUnreachable({ ...agent, compat: 'upgrade_required' })).toBe(
      true,
    );
    expect(
      isAgentUnreachable({ ...agent, source: 'system', online: false }),
    ).toBe(false);
    expect(isAgentDown({ ...agent, source: 'system', online: false })).toBe(
      true,
    );
    expect(isAgentDown({ ...agent, source: 'system' })).toBe(false);
  });
});

describe('plan model (protocol-pm-assistant §4)', () => {
  const row = (overrides: Partial<PmPlanRow>): PmPlanRow => ({
    seq: 1,
    ref: null,
    type: 'issue.create',
    params: {},
    status: 'pending',
    ok: true,
    preview: [],
    flags: [],
    warnings: [],
    ...overrides,
  });
  const plan: PmPlan = {
    id: 'p1',
    conversationId: 'c1',
    status: 'pending',
    title: 'T',
    summary: null,
    revision: 2,
    expiresAt: '2026-10-01T00:00:00Z',
    executable: true,
    result: null,
    createdAt: '',
    executedAt: null,
    rows: [
      row({ seq: 1, ref: 't1', params: { title: 'Parent' } }),
      row({
        seq: 2,
        ref: 't2',
        params: { title: 'Child', parent: { ref: 't1' } },
      }),
      row({
        seq: 3,
        params: {
          title: 'Grandchild',
          parent: { ref: 't2' },
          blockedBy: [{ issue: 'NP-4' }],
        },
      }),
      row({
        seq: 4,
        type: 'issue.update',
        params: { issue: 'NP-5', set: { priority: 'high' } },
        baseline: { priority: 'low' },
        flags: ['ownerChange'],
      }),
    ],
  };

  it('builds the tree and protects rows others depend on', () => {
    const views = rowViews(plan, new Map());
    expect(views.map((view) => view.depth)).toEqual([0, 1, 2, 0]);
    const used = referencedRefs(views);
    expect(canRemove(views[0], used)).toBe(false);
    expect(canRemove(views[1], used)).toBe(false);
    expect(canRemove(views[2], used)).toBe(true);
    // Removing the grandchild frees its parent.
    const edited = rowViews(plan, new Map([[3, { removed: true }]]));
    expect(canRemove(edited[1], referencedRefs(edited))).toBe(true);
  });

  it('turns edits into the PATCH body with the revision', () => {
    const edits = new Map([
      [2, { params: { title: 'Kid', parent: { ref: 't1' } } }],
      [3, { removed: true }],
    ]);
    expect(planEdit(plan, edits)).toEqual({
      revision: 2,
      ops: [
        { seq: 2, params: { title: 'Kid', parent: { ref: 't1' } } },
        { seq: 3, removed: true },
      ],
    });
    expect(planEdit(plan, new Map())).toBeNull();
  });

  it('diffs an update against its baseline and asks to confirm owner changes', () => {
    const views = rowViews(plan, new Map());
    expect(updateChanges(views[3])).toEqual([
      { field: 'priority', from: 'low', to: 'high' },
    ]);
    expect(rowsToConfirm(views).map((view) => view.row.seq)).toEqual([4]);
    expect(
      rowsToConfirm(rowViews(plan, new Map([[4, { removed: true }]]))),
    ).toEqual([]);
  });

  it('maps error codes and counts down the hours', () => {
    expect(rowErrorKey('STALE_TARGET')).toBe(
      'np.pmAssistant.plan.errors.STALE_TARGET',
    );
    expect(rowErrorKey('SOMETHING')).toBeNull();
    const now = Date.parse('2026-09-30T00:00:00Z');
    expect(hoursLeft('2026-09-30T23:10:00Z', now)).toBe(23);
    expect(hoursLeft('2026-09-30T00:10:00Z', now)).toBe(1);
    expect(hoursLeft('2026-09-29T00:00:00Z', now)).toBe(0);
  });
});
