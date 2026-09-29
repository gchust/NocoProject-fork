import { describe, expect, it } from 'vitest';

import {
  isEditableTarget,
  isSearchShortcut,
  modifierKeyLabel,
} from '../../client/components/np-shortcut-keys.js';
import { visibleConfigTabs } from '../../client/pages/np/config/config-model.js';
import {
  thresholdDraft,
  thresholdsFromDraft,
} from '../../client/pages/np/config/thresholds-model.js';
import {
  transitionCell,
  transitionMatrix,
  workflowFlow,
  workflowRules,
} from '../../client/pages/np/config/workflow-model.js';
import {
  actionBody,
  apiPath,
  defaultInboxActions,
  externalUrl,
  inAppPath,
  readInboxActions,
} from '../../client/pages/np/inbox/decision-actions.js';
import { inboxItemLink } from '../../client/pages/np/inbox/inbox-model.js';
import {
  newIssueCloseSearch,
  newIssueRedirectTarget,
} from '../../client/pages/np/issues/new-issue-model.js';
import {
  canEditKnowledge,
  filterKnowledge,
  readKnowledgeScope,
} from '../../client/pages/np/knowledge/knowledge-model.js';
import { myIssueFilters } from '../../client/pages/np/my-issues/my-issues-model.js';
import type {
  InboxItem,
  ProjectListItem,
} from '../../client/pages/np/types.js';
import type {
  KnowledgeDocSummary,
  WorkflowDefinitionV3,
} from '../../client/pages/np/types-iter3.js';

const DEFINITION: WorkflowDefinitionV3 = {
  statuses: [
    {
      key: 'backlog',
      name: 'Backlog',
      category: 'unstarted',
      color: 'gray',
      builtIn: true,
    },
    {
      key: 'todo',
      name: 'Todo',
      category: 'unstarted',
      color: 'blue',
      builtIn: true,
    },
    {
      key: 'in_progress',
      name: 'In Progress',
      category: 'started',
      color: 'yellow',
      builtIn: true,
    },
    {
      key: 'in_review',
      name: 'In Review',
      category: 'started',
      color: 'purple',
      builtIn: true,
    },
    {
      key: 'blocked',
      name: 'Blocked',
      category: 'started',
      color: 'red',
      builtIn: true,
    },
    {
      key: 'done',
      name: 'Done',
      category: 'done',
      color: 'green',
      builtIn: true,
    },
    {
      key: 'cancelled',
      name: 'Cancelled',
      category: 'closed',
      color: 'gray',
      builtIn: true,
    },
  ],
  transitions: [
    { from: '*', to: '*', actors: ['user'] },
    { from: 'todo', to: 'in_progress', actors: ['agent'] },
    { from: 'in_progress', to: 'in_review', actors: ['agent'] },
    {
      from: 'in_review',
      to: 'done',
      actors: ['user', 'agent'],
      approval: { approvers: ['owner', 'projectLead'] },
    },
    { from: '*', to: 'done', actors: ['system'] },
  ],
  childBatchDoneWakesParentExecutor: true,
};

function inboxItem(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: 'n1',
    kind: 'decision',
    type: 'review_requested',
    issueId: '7',
    issueIdentifier: 'NP-7',
    title: 't',
    body: '',
    actorType: null,
    actorName: null,
    count: 1,
    readAt: null,
    archivedAt: null,
    resolvedAt: null,
    payload: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('workflow templates (§F)', () => {
  it('puts blocked and cancelled on side branches and orders the main line by category', () => {
    const { main, side } = workflowFlow(DEFINITION);
    expect(main.map((status) => status.key)).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'done',
    ]);
    expect(side.map((status) => status.key)).toEqual(['blocked', 'cancelled']);
  });

  it('unions wildcard and specific transitions per cell and marks approvals', () => {
    expect(
      transitionCell(DEFINITION.transitions, 'todo', 'in_progress'),
    ).toEqual({ actors: ['user', 'agent'], approval: null });
    expect(transitionCell(DEFINITION.transitions, 'in_review', 'done')).toEqual(
      {
        actors: ['user', 'agent', 'system'],
        approval: ['owner', 'projectLead'],
      },
    );
    expect(transitionCell(DEFINITION.transitions, 'backlog', 'done')).toEqual({
      actors: ['user', 'system'],
      approval: null,
    });
    const matrix = transitionMatrix(DEFINITION);
    expect(matrix.keys).toHaveLength(7);
    const todo = matrix.rows.find((row) => row.from === 'todo');
    expect(todo?.cells.find((cell) => cell.to === 'todo')?.actors).toEqual([]);
  });

  it('lists approvals first, then the other transitions and the sub-issue rule', () => {
    const rules = workflowRules(DEFINITION);
    expect(rules[0]).toMatchObject({ kind: 'transition', from: 'in_review' });
    expect(rules.at(-1)).toEqual({ kind: 'childBatchDone', enabled: true });
    expect(rules).toHaveLength(DEFINITION.transitions.length + 1);
  });
});

describe('inbox decision actions (§E)', () => {
  it('reads the server actions and drops unusable ones', () => {
    const actions = readInboxActions(
      inboxItem({
        payload: {
          actions: [
            {
              key: 'accept',
              label: 'np.inboxActions.accept',
              kind: 'primary',
              method: 'post',
              path: '/np/issues/7/deliveries/accept',
            },
            { key: 'broken', kind: 'danger' },
            { label: 'no key', path: '/x' },
            { key: 'open', opensIssue: true, kind: 'weird' },
          ],
        },
      }),
    );
    expect(
      actions.map((action) => [action.key, action.kind, action.method]),
    ).toEqual([
      ['accept', 'primary', 'POST'],
      ['open', 'secondary', undefined],
    ]);
  });

  it('falls back to the per-type defaults when the payload has none', () => {
    expect(readInboxActions(inboxItem({})).map((action) => action.key)).toEqual(
      ['accept', 'requestChanges', 'open'],
    );
    expect(
      defaultInboxActions(
        inboxItem({ type: 'approval_pending', payload: { requestId: 'a1' } }),
      ).map((action) => [action.key, action.path, action.needsComment]),
    ).toEqual([
      ['approve', '/np/approvals/a1/approve', undefined],
      ['reject', '/np/approvals/a1/reject', true],
      ['open', undefined, undefined],
    ]);
    expect(
      defaultInboxActions(
        inboxItem({
          type: 'knowledge_proposal' as never,
          issueId: null,
          payload: { proposalId: 'kp' },
        }),
      ).map((action) => action.path),
    ).toEqual([
      '/np/knowledge/proposals/kp/accept',
      '/np/knowledge/proposals/kp/reject',
    ]);
    expect(
      readInboxActions(inboxItem({ kind: 'info', type: 'commented' })),
    ).toEqual([]);
  });

  it('builds the request: API path, comment as content for a reply, as comment otherwise', () => {
    expect(apiPath('/np/issues/7/comments')).toBe('np/issues/7/comments');
    expect(apiPath('/api/np/x')).toBe('np/x');
    expect(
      actionBody(
        { key: 'reply', label: '', kind: 'primary', body: { content: '' } },
        ' hi ',
      ),
    ).toEqual({ content: 'hi' });
    expect(
      actionBody(
        { key: 'requestChanges', label: '', kind: 'secondary' },
        'fix it',
      ),
    ).toEqual({ comment: 'fix it' });
    expect(
      actionBody({ key: 'accept', label: '', kind: 'primary' }, '  '),
    ).toEqual({});
    expect(
      externalUrl({
        key: 'openPr',
        label: '',
        kind: 'primary',
        url: 'https://github.com/a/b/pull/1',
      }),
    ).toBe('https://github.com/a/b/pull/1');
    expect(
      externalUrl({
        key: 'x',
        label: '',
        kind: 'primary',
        url: 'javascript:alert(1)',
      }),
    ).toBeNull();
  });

  it('treats GET actions as navigation: in-app routes, or an external PR in a new tab (server §5)', () => {
    const [open, pr, reply] = readInboxActions(
      inboxItem({
        payload: {
          actions: [
            {
              key: 'open',
              label: 'np.inboxActions.open',
              kind: 'secondary',
              method: 'GET',
              path: '/issues/12',
              opensIssue: true,
            },
            {
              key: 'openPr',
              label: 'np.inboxActions.openPr',
              kind: 'primary',
              method: 'GET',
              path: 'https://github.com/a/b/pull/3',
              external: true,
            },
            {
              key: 'reply',
              label: 'np.inboxActions.reply',
              kind: 'primary',
              method: 'POST',
              path: '/np/issues/12/comments',
              needsComment: true,
              commentField: 'content',
            },
          ],
        },
      }),
    );
    expect(inAppPath(open)).toBe('/issues/12');
    expect(externalUrl(pr)).toBe('https://github.com/a/b/pull/3');
    expect(inAppPath(pr)).toBeNull();
    expect(inAppPath(reply)).toBeNull();
    expect(actionBody(reply, 'on it')).toEqual({ content: 'on it' });
  });

  it('opens an issue, or the knowledge document of a proposal', () => {
    expect(inboxItemLink(inboxItem({}))).toBe('/issues/7');
    expect(
      inboxItemLink(
        inboxItem({
          type: 'knowledge_proposal' as never,
          issueId: null,
          payload: { docId: 'k1' },
        }),
      ),
    ).toBe('/knowledge/k1');
    expect(
      inboxItemLink(inboxItem({ type: 'pr_merged', issueId: null })),
    ).toBeNull();
  });
});

describe('navigation helpers (§G)', () => {
  it('fixes the viewer as owner or executor on the my-issues tabs', () => {
    expect(myIssueFilters('owned', 'u1')).toEqual({
      fixedFilters: { ownerUserId: 'u1' },
      hiddenFilters: ['ownerUserId'],
    });
    expect(myIssueFilters('executing', 'u1')).toEqual({
      fixedFilters: { executorId: 'u1' },
      hiddenFilters: ['executorId'],
    });
  });

  it('shows GitHub settings to owner/admin only', () => {
    expect(visibleConfigTabs(true)).toEqual([
      'general',
      'members',
      'workflows',
      'labels',
      'github',
    ]);
    expect(visibleConfigTabs(false)).not.toContain('github');
  });

  it('sends old batch-entry links to the new issue dialog and cleans the query when it closes', () => {
    // Iteration 4 §D replaced the drawer with the AI tab of "New issue".
    expect(newIssueRedirectTarget('?batch=b1')).toBe(
      '/issues/new?tab=ai&batch=b1',
    );
    expect(newIssueRedirectTarget('?project=p%201&batch=b1')).toBe(
      '/issues/new?tab=ai&project=p+1&batch=b1',
    );
    expect(newIssueRedirectTarget('', 'p2')).toBe(
      '/issues/new?tab=ai&project=p2',
    );
    expect(newIssueCloseSearch('?view=board&tab=ai&batch=b1&project=p1')).toBe(
      '?view=board&project=p1',
    );
    expect(newIssueCloseSearch('?batch=b1&tab=manual')).toBe('');
  });

  it('round-trips the metric thresholds form and rejects out-of-range values', () => {
    const draft = thresholdDraft(undefined);
    expect(draft).toMatchObject({
      aiShare: '50',
      proposalAcceptRate: '70',
      decisionResolveHours: '24',
    });
    expect(thresholdsFromDraft(draft)).toEqual({
      aiShare: 0.5,
      proposalAcceptRate: 0.7,
      claimLatencyP50Ms: 3000,
      lostRuns: 0,
      decisionResolveP50Ms: 86_400_000,
    });
    expect(thresholdsFromDraft({ ...draft, aiShare: '120' })).toBeNull();
    expect(thresholdsFromDraft({ ...draft, lostRuns: '' })).toBeNull();
  });

  it('recognizes typing targets and the search shortcut', () => {
    const input = document.createElement('input');
    const div = document.createElement('div');
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(
      isSearchShortcut({
        key: 'k',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isSearchShortcut({
        key: 'K',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isSearchShortcut({
        key: 'k',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBe(false);
  });
});

describe('knowledge rules (§B)', () => {
  const projects: ProjectListItem[] = [
    { id: 'p1', name: 'Web', leadUserId: 'lead' },
  ];
  const doc = (
    overrides: Partial<KnowledgeDocSummary>,
  ): KnowledgeDocSummary => ({
    id: 'k',
    projectId: 'p1',
    title: 't',
    slug: 's',
    summary: null,
    version: 1,
    updatedAt: '2026-01-01',
    ...overrides,
  });

  it('lets the project lead and owner/admin edit; workspace documents are owner/admin only', () => {
    const lead = { userId: 'lead', role: 'member' as const };
    const member = { userId: 'm', role: 'member' as const };
    const admin = { userId: 'a', role: 'admin' as const };
    expect(canEditKnowledge(doc({}), lead, projects)).toBe(true);
    expect(canEditKnowledge(doc({}), member, projects)).toBe(false);
    expect(canEditKnowledge(doc({ projectId: null }), lead, projects)).toBe(
      false,
    );
    expect(canEditKnowledge(doc({ projectId: null }), admin, projects)).toBe(
      true,
    );
    // The server's answer wins.
    expect(canEditKnowledge(doc({ canEdit: true }), member, projects)).toBe(
      true,
    );
  });

  it('filters workspace documents and lists archived ones last', () => {
    const docs = [
      doc({ id: 'a', archivedAt: '2026-01-02', updatedAt: '2026-01-03' }),
      doc({ id: 'b', projectId: null, updatedAt: '2026-01-01' }),
      doc({ id: 'c', updatedAt: '2026-01-02' }),
    ];
    expect(
      filterKnowledge(docs, readKnowledgeScope(null)).map((d) => d.id),
    ).toEqual(['c', 'b', 'a']);
    expect(
      filterKnowledge(docs, readKnowledgeScope('workspace')).map((d) => d.id),
    ).toEqual(['b']);
    expect(readKnowledgeScope('p1')).toEqual({
      kind: 'project',
      projectId: 'p1',
    });
  });
});

describe('modifier key label', () => {
  it('shows ⌘ on Apple platforms and Ctrl elsewhere', () => {
    expect(modifierKeyLabel('MacIntel')).toBe('⌘');
    expect(modifierKeyLabel('iPhone')).toBe('⌘');
    expect(modifierKeyLabel('Win32')).toBe('Ctrl');
    expect(modifierKeyLabel('Linux x86_64')).toBe('Ctrl');
    expect(modifierKeyLabel('')).toBe('Ctrl');
  });
});
