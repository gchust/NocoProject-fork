// @vitest-environment node

/**
 * Pure helpers behind Phase 1 iteration 4 in the browser (`docs/phase1/iteration-4-contract.md`): the process and
 * agent-kind readers, the design-first board columns, the proposal and retrospective comment tags, the project
 * manager conversation, the design review decision's actions and the new issue dialog's tab.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  agentKind,
  commentTag,
  ensurePmConversation,
  executorCandidates,
  issueProcess,
  latestProposalComment,
  normalizePmConversation,
  readDefaultProcess,
  readReasoningEffort,
} from '../../client/pages/np/api-iter4.js';
import {
  DEFAULT_STATUS_CATALOG,
  statusTone,
} from '../../client/pages/np/constants.js';
import {
  pmSettingsDraft,
  pmSettingsInput,
} from '../../client/pages/np/config/pm-settings-model.js';
import { normalizeComments } from '../../client/pages/np/detail-normalize.js';
import { readInboxActions } from '../../client/pages/np/inbox/decision-actions.js';
import { inboxBodyText } from '../../client/pages/np/inbox/inbox-text.js';
import {
  buildBoardColumns,
  withoutIdleDesignColumns,
} from '../../client/pages/np/issues/board/board-model.js';
import { activityLabel } from '../../client/pages/np/issues/detail/timeline.js';
import { resolveNewIssueTab } from '../../client/pages/np/issues/new-issue-model.js';
import { pmNotConfigured } from '../../client/pages/np/pm/pm-model.js';
import type {
  AgentListItem,
  IssueComment,
  IssueDetail,
  IssueListItem,
  RunSummary,
} from '../../client/pages/np/types.js';

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
    ...overrides,
  };
}

function comment(overrides: Partial<IssueComment>): IssueComment {
  return {
    id: 'c1',
    authorType: 'agent',
    authorId: 'a1',
    content: 'Hello',
    parentId: null,
    createdAt: NOW,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentListItem>): AgentListItem {
  return {
    id: 'a1',
    name: 'Coder',
    runtimeId: 'r1',
    provider: 'claude',
    ...overrides,
  };
}

describe('process and agent kind readers', () => {
  it('reads anything but design_first as direct, and unknown settings as automatic', () => {
    expect(issueProcess(issue({ process: 'design_first' }))).toBe(
      'design_first',
    );
    expect(issueProcess(issue({}))).toBe('direct');
    expect(issueProcess(undefined)).toBe('direct');
    expect(readDefaultProcess('direct')).toBe('direct');
    expect(readDefaultProcess('weird')).toBe('auto');
    expect(readDefaultProcess(undefined)).toBe('auto');
  });

  it('reads the agent kind and reasoning effort tolerantly', () => {
    expect(agentKind(agent({ kind: 'manager' }))).toBe('manager');
    expect(agentKind(agent({}))).toBe('coder');
    expect(readReasoningEffort('high')).toBe('high');
    expect(readReasoningEffort('extreme')).toBeNull();
    expect(readReasoningEffort(null)).toBeNull();
  });

  it('keeps project managers out of executor pickers unless already chosen', () => {
    const agents = [
      agent({ id: 'a1' }),
      agent({ id: 'pm', name: 'PM', kind: 'manager' }),
    ];
    expect(executorCandidates(agents).map((item) => item.id)).toEqual(['a1']);
    expect(executorCandidates(agents, 'pm').map((item) => item.id)).toEqual([
      'a1',
      'pm',
    ]);
  });
});

describe('design-first statuses', () => {
  it('adds analysis and proposal review after todo, review drawn like in review', () => {
    expect(
      DEFAULT_STATUS_CATALOG.map((entry) => entry.key).slice(0, 4),
    ).toEqual(['backlog', 'todo', 'analysis', 'proposal_review']);
    expect(statusTone('analysis')).toBe('blue');
    expect(statusTone('proposal_review')).toBe('violet');
  });

  it('shows the design columns only while one holds an issue or a visible issue is design-first', () => {
    const keys = (groups: Parameters<typeof buildBoardColumns>[1]) =>
      buildBoardColumns(DEFAULT_STATUS_CATALOG, groups).map(
        (column) => column.statusKey,
      );
    expect(keys([{ statusKey: 'todo', issues: [issue({})] }])).not.toContain(
      'analysis',
    );
    expect(
      keys([
        {
          statusKey: 'todo',
          issues: [issue({ process: 'design_first' })],
        },
      ]),
    ).toEqual(expect.arrayContaining(['analysis', 'proposal_review']));
    const inReview = keys([
      {
        statusKey: 'proposal_review',
        issues: [issue({ statusKey: 'proposal_review' })],
      },
    ]);
    expect(inReview).toContain('proposal_review');
    // An issue sitting in proposal review without the field (an older row) still keeps its column.
    expect(
      withoutIdleDesignColumns([
        { statusKey: 'analysis', issues: [] },
        { statusKey: 'todo', issues: [] },
      ]).map((column) => column.statusKey),
    ).toEqual(['todo']);
  });
});

describe('proposal and retrospective comments', () => {
  const runs: RunSummary[] = [
    {
      id: 'r-retro',
      agentId: 'pm',
      status: 'completed',
      triggerType: 'retrospective',
      createdAt: NOW,
    },
    {
      id: 'r-work',
      agentId: 'a1',
      status: 'completed',
      triggers: [{ type: 'assign' }],
      createdAt: NOW,
    },
  ];

  it('tags a proposal, a note written by a retrospective run, and a server-marked retrospective', () => {
    expect(commentTag(comment({ kind: 'proposal' }), runs)).toBe('proposal');
    expect(commentTag(comment({ sourceRunId: 'r-retro' }), runs)).toBe(
      'retrospective',
    );
    expect(commentTag(comment({ sourceRunId: 'r-work' }), runs)).toBeNull();
    expect(
      commentTag(
        { ...comment({}), kind: 'retrospective' } as unknown as IssueComment,
        [],
      ),
    ).toBe('retrospective');
    expect(commentTag(comment({}), runs)).toBeNull();
  });

  it('finds the proposal a decision names, else the newest, else the embedded one', () => {
    const detail = {
      issue: { ...issue({}), description: null, revision: 1, createdAt: NOW },
      threads: normalizeComments([
        comment({ id: 'p1', kind: 'proposal', content: 'First' }),
        comment({
          id: 'p2',
          kind: 'proposal',
          content: 'Second',
          createdAt: '2026-09-27T11:00:00.000Z',
        }),
        comment({ id: 'x', content: 'Chat' }),
      ]),
    } as unknown as IssueDetail;
    expect(latestProposalComment(detail)?.id).toBe('p2');
    expect(latestProposalComment(detail, 'p1')?.content).toBe('First');
    const embedded = {
      issue: {
        ...detail.issue,
        designProposal: {
          commentId: 'e1',
          content: 'Embedded',
          createdAt: NOW,
        },
      },
      threads: [],
    } as unknown as IssueDetail;
    expect(latestProposalComment(embedded)?.content).toBe('Embedded');
    expect(latestProposalComment(undefined)).toBeNull();
  });
});

describe('design review decision', () => {
  it('defaults to approve / send back (with a comment) / open', () => {
    const actions = readInboxActions({
      kind: 'decision',
      type: 'design_review',
      issueId: '12',
      payload: {},
    } as never);
    expect(actions.map((action) => [action.key, action.path])).toEqual([
      ['approve', '/np/issues/12/design/approve'],
      ['requestChanges', '/np/issues/12/design/request-changes'],
      ['open', undefined],
    ]);
    expect(actions[0].kind).toBe('primary');
    expect(actions[1].needsComment).toBe(true);
  });

  it('prefers the server actions and localizes the sentence', () => {
    const actions = readInboxActions({
      kind: 'decision',
      type: 'design_review',
      issueId: '12',
      payload: {
        actions: [
          {
            key: 'approve',
            kind: 'primary',
            method: 'POST',
            path: '/np/issues/12/design/approve',
          },
        ],
      },
    } as never);
    expect(actions.map((action) => action.key)).toEqual(['approve']);
    expect(
      inboxBodyText(
        { type: 'design_review', payload: {}, actorName: 'Echo' } as never,
        (key) => key,
        (reason) => reason,
      ),
    ).toEqual({ key: 'np.inboxBody.design_review', values: { actor: 'Echo' } });
  });

  it('labels the design activities', () => {
    expect(activityLabel('process_selected')).toBe('processSelected');
    expect(activityLabel('design_approved')).toBe('designApproved');
    expect(activityLabel('design_changes_requested')).toBe(
      'designChangesRequested',
    );
    expect(activityLabel('design_skipped')).toBe('designSkipped');
    expect(activityLabel('retrospective_done')).toBe('retrospectiveDone');
  });
});

describe('project manager conversation', () => {
  it('reads the issue id from the plausible shapes', () => {
    expect(normalizePmConversation({ data: { issueId: 'i1' } })).toEqual({
      issueId: 'i1',
    });
    expect(normalizePmConversation({ data: { issue: { id: 'i2' } } })).toEqual({
      issueId: 'i2',
    });
    expect(normalizePmConversation({ id: 'i3' })).toEqual({ issueId: 'i3' });
    expect(normalizePmConversation({ data: null })).toEqual({ issueId: null });
  });

  it('finds the conversation, and creates it when there is none yet', async () => {
    const found = {
      request: vi.fn().mockResolvedValue({ data: { issueId: 'i1' } }),
    };
    expect(await ensurePmConversation(found as never)).toEqual({
      issueId: 'i1',
    });
    expect(found.request).toHaveBeenCalledTimes(1);

    const created = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ data: { issueId: null } })
        .mockResolvedValueOnce({ data: { issueId: 'i9' } }),
    };
    expect(await ensurePmConversation(created as never)).toEqual({
      issueId: 'i9',
    });
    expect(created.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: 'np/pm/conversation', method: 'POST' }),
    );

    const missing = {
      request: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('nf'), { status: 404 }))
        .mockResolvedValueOnce({ data: { issueId: 'i8' } }),
    };
    expect(await ensurePmConversation(missing as never)).toEqual({
      issueId: 'i8',
    });

    const refused = {
      request: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('no'), { status: 409 })),
    };
    await expect(ensurePmConversation(refused as never)).rejects.toThrow('no');
  });

  it('knows when the settings say there is no project manager', () => {
    expect(pmNotConfigured({ pmAgentId: null })).toBe(true);
    expect(pmNotConfigured({ pmAgentId: 'pm' })).toBe(false);
    expect(pmNotConfigured({})).toBe(false);
  });

  it('round-trips the settings fields with the contract defaults', () => {
    expect(pmSettingsDraft({})).toEqual({
      defaultProcess: 'auto',
      pmAgentId: null,
      retrospectiveOnDone: true,
    });
    const draft = pmSettingsDraft({
      defaultProcess: 'design_first',
      pmAgentId: 'pm',
      retrospectiveOnDone: false,
    });
    expect(pmSettingsInput(draft)).toEqual({
      defaultProcess: 'design_first',
      pmAgentId: 'pm',
      retrospectiveOnDone: false,
    });
  });
});

describe('new issue dialog tab', () => {
  it('reads ?tab=, then a draft batch, then the stored tab, then AI', () => {
    const params = (search: string) => new URLSearchParams(search);
    expect(resolveNewIssueTab(params('?tab=manual'), 'ai')).toBe('manual');
    expect(resolveNewIssueTab(params('?batch=b1'), 'manual')).toBe('ai');
    expect(resolveNewIssueTab(params(''), 'manual')).toBe('manual');
    expect(resolveNewIssueTab(params('?tab=other'), null)).toBe('ai');
  });
});
