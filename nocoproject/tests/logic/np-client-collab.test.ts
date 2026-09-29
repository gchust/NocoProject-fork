// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { initials } from '../../client/pages/np/format.js';
import {
  applyInboxActionLocally,
  inboxActionsFor,
  inboxUnread,
  isSettled,
  readInboxTab,
} from '../../client/pages/np/inbox/inbox-model.js';
import {
  groupSubtasksByStage,
  pendingProposals,
} from '../../client/pages/np/issues/detail/subtask-model.js';
import { activityLabel } from '../../client/pages/np/issues/detail/timeline.js';
import { toolSummary } from '../../client/pages/np/issues/detail/tool-summary.js';
import {
  canActAsIssueOwner,
  canChangeMemberRole,
  canEditAgent,
  canEditProject,
  memberRoleOptions,
  viewerFrom,
} from '../../client/pages/np/permissions.js';
import {
  githubRepoOf,
  isGitRepoUrl,
} from '../../client/pages/np/projects/detail/resource-url.js';
import {
  progressFromCounts,
  progressFromGroups,
} from '../../client/pages/np/projects/progress.js';
import type {
  ExecutorProposal,
  InboxItem,
  IssueListItem,
  Member,
  SubtaskSummary,
} from '../../client/pages/np/types.js';

const NOW = '2026-09-27T10:00:00.000Z';

function subtask(overrides: Partial<SubtaskSummary>): SubtaskSummary {
  return {
    id: 's',
    identifier: 'NP-9',
    title: 'Sub',
    statusKey: 'todo',
    stage: null,
    executorName: null,
    blockedCount: 0,
    ...overrides,
  };
}

function member(userId: string, role: Member['role']): Member {
  return { userId, name: userId, email: null, role };
}

describe('sub-issues and proposals', () => {
  it('groups sub-issues by stage, lowest first and unstaged last, counting terminal ones', () => {
    const groups = groupSubtasksByStage([
      subtask({ id: 'a', stage: 2 }),
      subtask({ id: 'b', stage: null }),
      subtask({ id: 'c', stage: 1, statusKey: 'done' }),
      subtask({ id: 'd', stage: 1, statusKey: 'cancelled' }),
      subtask({ id: 'e', stage: 1 }),
    ]);
    expect(groups.map((group) => group.stage)).toEqual([1, 2, null]);
    expect(groups[0].subtasks.map((item) => item.id)).toEqual(['c', 'd', 'e']);
    expect(groups[0].done).toBe(2);
    expect(groups[1].done).toBe(0);
  });

  it('keeps only pending proposals, oldest first', () => {
    const base: ExecutorProposal = {
      id: 'p',
      issueId: 'i',
      issueIdentifier: 'NP-2',
      issueTitle: 'T',
      proposedAgentId: 'a1',
      proposedAgentName: 'Coder',
      proposedByAgentId: 'a2',
      proposedByAgentName: 'Lead',
      sourceRunId: null,
      status: 'pending',
      decidedById: null,
      decidedAt: null,
      reason: null,
      createdAt: NOW,
    };
    const result = pendingProposals([
      { ...base, id: 'late', createdAt: '2026-09-27T12:00:00.000Z' },
      { ...base, id: 'done', status: 'accepted' },
      { ...base, id: 'early', createdAt: '2026-09-27T08:00:00.000Z' },
    ]);
    expect(result.map((proposal) => proposal.id)).toEqual(['early', 'late']);
  });
});

describe('project progress', () => {
  it('reads the list counts and rounds down', () => {
    expect(progressFromCounts({ total: 3, done: 2 })).toEqual({
      done: 2,
      total: 3,
      percent: 66,
    });
    expect(progressFromCounts(undefined)).toEqual({
      done: 0,
      total: 0,
      percent: 0,
    });
    expect(progressFromCounts({ total: 2, done: 5 }).done).toBe(2);
  });

  it('computes from board groups, leaving cancelled issues out', () => {
    const item = (statusKey: string): IssueListItem => ({
      id: statusKey,
      identifier: 'NP',
      title: 't',
      statusKey,
      priority: 'none',
      ownerUserId: null,
      executorType: 'none',
      executorId: null,
      updatedAt: NOW,
    });
    expect(
      progressFromGroups(
        [
          { statusKey: 'todo', issues: [item('todo'), item('in_progress')] },
          { statusKey: 'done', issues: [item('done')] },
          { statusKey: 'cancelled', issues: [item('cancelled')] },
        ],
        [
          { key: 'todo', category: 'unstarted', agentWritable: false },
          { key: 'in_progress', category: 'started', agentWritable: true },
          { key: 'done', category: 'done', agentWritable: false },
          { key: 'cancelled', category: 'closed', agentWritable: false },
        ],
      ),
    ).toEqual({ done: 1, total: 3, percent: 33 });
  });
});

describe('member role rules', () => {
  const members = [
    member('owner1', 'owner'),
    member('admin1', 'admin'),
    member('m1', 'member'),
  ];
  const as = (userId: string) => viewerFrom(userId, members);
  const enabled = (viewerId: string, target: Member, assignRoles = false) =>
    memberRoleOptions(as(viewerId), target, members, assignRoles)
      .filter((option) => !option.disabled)
      .map((option) => option.value);

  it('lets a plain member change nothing', () => {
    expect(canChangeMemberRole(as('m1'), members[2], members, false)).toBe(
      false,
    );
    expect(canChangeMemberRole(as('m1'), members[1], members, false)).toBe(
      false,
    );
  });

  it('leaves admin and member to whoever may assign roles in user management (NP-117)', () => {
    // A business admin alone changes no role.
    expect(enabled('admin1', members[2])).toEqual(['member']);
    expect(enabled('admin1', members[2], true)).toEqual(['admin', 'member']);
    expect(enabled('admin1', members[0], true)).toEqual(['owner']);
    expect(canChangeMemberRole(as('admin1'), members[0], members, true)).toBe(
      false,
    );
  });

  it('lets an owner grant owner, and never demote the last owner', () => {
    expect(enabled('owner1', members[2])).toEqual(['owner', 'member']);
    expect(enabled('owner1', members[2], true)).toEqual([
      'owner',
      'admin',
      'member',
    ]);
    expect(canChangeMemberRole(as('owner1'), members[0], members, true)).toBe(
      false,
    );
    const twoOwners = [...members, member('owner2', 'owner')];
    expect(
      canChangeMemberRole(
        viewerFrom('owner1', twoOwners),
        twoOwners[3],
        twoOwners,
        false,
      ),
    ).toBe(true);
  });

  it('applies the owner, lead and admin rules to issues, projects and agents', () => {
    const issue = { ownerUserId: 'm1' };
    expect(canActAsIssueOwner(as('m1'), issue)).toBe(true);
    expect(canActAsIssueOwner(as('m2'), issue)).toBe(false);
    expect(canActAsIssueOwner(as('m2'), issue, 'm2')).toBe(true);
    expect(canActAsIssueOwner(as('admin1'), issue)).toBe(true);
    expect(canActAsIssueOwner(null, issue)).toBe(false);
    expect(canEditProject(as('m1'), { leadUserId: 'm1' })).toBe(true);
    expect(canEditProject(as('m1'), { leadUserId: 'x' })).toBe(false);
    expect(canEditAgent(as('owner1'), { ownerUserId: 'x' })).toBe(true);
    expect(canEditAgent(as('m1'), { ownerUserId: 'x' })).toBe(false);
  });
});

describe('inbox model', () => {
  const item: InboxItem = {
    id: 'n1',
    kind: 'decision',
    type: 'review_requested',
    issueId: '101',
    issueIdentifier: 'NP-1',
    title: 'Review NP-1',
    body: '',
    actorType: 'agent',
    actorName: 'Coder',
    count: 1,
    readAt: null,
    archivedAt: null,
    resolvedAt: null,
    payload: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('offers the opposite of the current read and archive state', () => {
    expect(inboxActionsFor(item)).toEqual(['read', 'archive']);
    expect(inboxActionsFor({ ...item, readAt: NOW, archivedAt: NOW })).toEqual([
      'unread',
      'unarchive',
    ]);
  });

  it('applies an action locally for the optimistic update', () => {
    expect(applyInboxActionLocally(item, 'read', NOW).readAt).toBe(NOW);
    expect(
      applyInboxActionLocally({ ...item, readAt: NOW }, 'unread', NOW).readAt,
    ).toBeNull();
    expect(applyInboxActionLocally(item, 'archive', NOW).archivedAt).toBe(NOW);
  });

  it('reads the tab and prefers the dedicated unread counter', () => {
    expect(readInboxTab('info')).toBe('info');
    expect(readInboxTab('whatever')).toBe('decision');
    expect(
      inboxUnread({ decision: 1, info: 2 }, { decision: 9, info: 9 }),
    ).toEqual({ decision: 1, info: 2 });
    expect(inboxUnread(undefined, { decision: 3, info: 0 })).toEqual({
      decision: 3,
      info: 0,
    });
    expect(inboxUnread(undefined, null)).toEqual({ decision: 0, info: 0 });
    expect(isSettled({ ...item, resolvedAt: NOW })).toBe(true);
    expect(isSettled({ ...item, kind: 'info', resolvedAt: NOW })).toBe(false);
  });
});

describe('Phase 0 leftovers', () => {
  it('summarises a tool call by its command, file or query', () => {
    expect(toolSummary({ command: 'pnpm test\n--watch' })).toBe('$ pnpm test');
    expect(toolSummary({ command: ['bash', '-lc', 'git status'] })).toBe(
      '$ git status',
    );
    expect(toolSummary({ command: ['git', 'diff'] })).toBe('$ git diff');
    expect(toolSummary({ file_path: '/repo/a.ts', content: 'x' })).toBe(
      '/repo/a.ts',
    );
    expect(toolSummary({ pattern: 'TODO' })).toBe('TODO');
    expect(toolSummary({ other: 1 })).toBeNull();
    expect(toolSummary(null)).toBeNull();
  });

  it('labels the iteration 1 activity actions', () => {
    expect(activityLabel('run_deferred_blocked')).toBe('runDeferredBlocked');
    expect(activityLabel('dependency_added')).toBe('dependencyChanged');
    expect(activityLabel('labels_changed')).toBe('labelsChanged');
    expect(activityLabel('due_date_changed')).toBe('datesChanged');
    expect(activityLabel('status_changed')).toBe('statusChanged');
    expect(activityLabel('issue_updated')).toBe('updated');
  });

  it('accepts clonable repository URLs', () => {
    expect(isGitRepoUrl('https://github.com/nocobase/nocobase.git')).toBe(true);
    expect(isGitRepoUrl('git@github.com:nocobase/nocobase.git')).toBe(true);
    expect(isGitRepoUrl('ssh://git@host/repo.git')).toBe(true);
    expect(isGitRepoUrl('nocobase')).toBe(false);
    expect(isGitRepoUrl('https://github.com')).toBe(false);
  });

  it('finds the GitHub repository and its webhook page in every URL form', () => {
    const hooks = 'https://github.com/nocobase/nocoitam/settings/hooks/new';
    for (const url of [
      'https://github.com/nocobase/nocoitam.git',
      'https://github.com/nocobase/nocoitam',
      'git@github.com:nocobase/nocoitam.git',
      'ssh://git@github.com/nocobase/nocoitam.git',
    ])
      expect(githubRepoOf(url)).toEqual({
        fullName: 'nocobase/nocoitam',
        webhookSettingsUrl: hooks,
      });
    expect(
      githubRepoOf('https://github.acme.com/team/app.git')?.webhookSettingsUrl,
    ).toBe('https://github.acme.com/team/app/settings/hooks/new');
    expect(githubRepoOf('https://gitlab.com/acme/tool.git')).toBeNull();
    expect(githubRepoOf('https://github.com/nocobase')).toBeNull();
    expect(githubRepoOf('')).toBeNull();
  });

  it('makes avatar initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('周')).toBe('周');
    expect(initials('zhou')).toBe('ZH');
    expect(initials('  ')).toBe('?');
  });
});
