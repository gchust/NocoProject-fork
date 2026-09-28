import { describe, expect, it } from 'vitest';

import { normalizeUsage, sumUsage } from '../../client/pages/np/api-iter2.js';
import { normalizeIssueUpdate } from '../../client/pages/np/api.js';
import {
  approverNames,
  canDecideApproval,
  pendingApprovals,
} from '../../client/pages/np/approval-model.js';
import { normalizeIssueDetail } from '../../client/pages/np/detail-normalize.js';
import {
  ciReading,
  looksLikePullRequestUrl,
  mergeableReading,
  prBadgeState,
} from '../../client/pages/np/issues/detail/pr-model.js';
import {
  hasReacted,
  toggleReaction,
  updateDetailComment,
  visibleReactions,
} from '../../client/pages/np/issues/detail/reaction-model.js';
import {
  type ApprovalRequest,
  REACTION_EMOJIS,
} from '../../client/pages/np/types-iter2.js';
import type { UsageRow } from '../../client/pages/np/types.js';
import {
  defaultUsageRange,
  formatCost,
  formatTokens,
  readUsageGroup,
  sortUsageRows,
  usageForIssue,
} from '../../client/pages/np/usage-model.js';

describe('pull request cards', () => {
  it('reads the four badge states', () => {
    expect(prBadgeState({ state: 'open', draft: false })).toBe('open');
    expect(prBadgeState({ state: 'open', draft: true })).toBe('draft');
    expect(prBadgeState({ state: 'merged', draft: true })).toBe('merged');
    expect(prBadgeState({ state: 'closed', draft: false })).toBe('closed');
    // A snapshot that recorded the merge time reads as merged even before the state catches up.
    expect(
      prBadgeState({ state: 'closed', draft: false, mergedAt: '2026-09-27' }),
    ).toBe('merged');
  });

  it('folds CI and mergeability into what a reader acts on', () => {
    expect(ciReading(null)).toBe('none');
    expect(ciReading('failure')).toBe('failure');
    expect(mergeableReading('clean')).toBe('mergeable');
    expect(mergeableReading('unstable')).toBe('mergeable');
    expect(mergeableReading('dirty')).toBe('conflicts');
    expect(mergeableReading('blocked')).toBe('blocked');
    expect(mergeableReading('behind')).toBe('behind');
    expect(mergeableReading(null)).toBe('unknown');
  });

  it('accepts pull request URLs only', () => {
    expect(looksLikePullRequestUrl('https://github.com/o/r/pull/12')).toBe(
      true,
    );
    expect(looksLikePullRequestUrl(' https://ghe.acme.io/o/r/pull/3/ ')).toBe(
      true,
    );
    expect(looksLikePullRequestUrl('https://github.com/o/r/issues/12')).toBe(
      false,
    );
    expect(looksLikePullRequestUrl('github.com/o/r/pull/12')).toBe(false);
  });
});

const APPROVAL: ApprovalRequest = {
  id: 'ap1',
  issueId: '101',
  fromStatus: 'in_review',
  toStatus: 'done',
  requestedByType: 'agent',
  requestedById: 'a1',
  approverUserIds: ['u1', 'u2'],
  status: 'pending',
  createdAt: '2026-09-27T01:00:00Z',
};

describe('approvals', () => {
  it('lets only listed approvers decide a pending request', () => {
    expect(canDecideApproval(APPROVAL, 'u1')).toBe(true);
    expect(canDecideApproval(APPROVAL, 'u3')).toBe(false);
    expect(canDecideApproval(APPROVAL, undefined)).toBe(false);
    expect(canDecideApproval({ ...APPROVAL, status: 'approved' }, 'u1')).toBe(
      false,
    );
  });

  it('lists pending requests oldest first and names approvers', () => {
    const later = { ...APPROVAL, id: 'ap2', createdAt: '2026-09-27T02:00:00Z' };
    const decided = { ...APPROVAL, id: 'ap0', status: 'rejected' as const };
    expect(
      pendingApprovals([later, decided, APPROVAL]).map((a) => a.id),
    ).toEqual(['ap1', 'ap2']);
    expect(
      approverNames(APPROVAL, [
        { userId: 'u1', name: 'Zhou', email: null, role: 'owner' },
      ]),
    ).toEqual(['Zhou', 'u2']);
    expect(
      approverNames({ ...APPROVAL, approverNames: ['A', 'B'] }, []),
    ).toEqual(['A', 'B']);
  });

  it('reads a 202 approval answer and a plain update the same way', () => {
    const issue = { id: '101', statusKey: 'in_review' };
    expect(
      normalizeIssueUpdate({ data: { issue, pendingApproval: APPROVAL } }),
    ).toEqual({ issue, pendingApproval: APPROVAL });
    expect(normalizeIssueUpdate({ data: issue })).toEqual({
      issue,
      pendingApproval: null,
    });
  });

  it('defaults the iteration 2 detail fields when the server omits them', () => {
    const detail = normalizeIssueDetail({
      issue: {
        id: '1',
        identifier: 'NP-1',
        title: 't',
        statusKey: 'todo',
        priority: 'none',
        ownerUserId: null,
        executorType: 'none',
        executorId: null,
        description: null,
        revision: 1,
        createdAt: 'x',
        updatedAt: 'x',
      },
    });
    expect(detail.pullRequests).toEqual([]);
    expect(detail.approvals).toEqual([]);
    expect(detail.queuedRun).toBeNull();
    expect(detail.usage).toBeNull();
  });
});

describe('reactions', () => {
  const reactions = [{ emoji: '👍', count: 2, userIds: ['u1', 'u2'] }];

  it('toggles the viewer’s own reaction', () => {
    expect(hasReacted(reactions, '👍', 'u1')).toBe(true);
    expect(toggleReaction(reactions, '👍', 'u1')).toEqual([
      { emoji: '👍', count: 1, userIds: ['u2'] },
    ]);
    expect(toggleReaction(reactions, '👍', 'u3')).toEqual([
      { emoji: '👍', count: 3, userIds: ['u1', 'u2', 'u3'] },
    ]);
    expect(toggleReaction(reactions, '🎉', 'u1')).toEqual([
      ...reactions,
      { emoji: '🎉', count: 1, userIds: ['u1'] },
    ]);
    expect(
      toggleReaction([{ emoji: '👀', count: 1, userIds: ['u1'] }], '👀', 'u1'),
    ).toEqual([]);
  });

  it('shows used reactions in the order of the fixed set', () => {
    expect(REACTION_EMOJIS).toHaveLength(8);
    const shown = visibleReactions(
      [
        { emoji: '👎', count: 1, userIds: ['u1'] },
        { emoji: '👍', count: 1, userIds: ['u2'] },
        { emoji: '🚀', count: 0, userIds: [] },
      ],
      REACTION_EMOJIS,
    );
    expect(shown.map((reaction) => reaction.emoji)).toEqual(['👍', '👎']);
  });

  it('updates a reply inside a thread', () => {
    const comment = (id: string) => ({
      id,
      authorType: 'user' as const,
      authorId: 'u1',
      content: id,
      parentId: null,
      createdAt: '2026',
    });
    const detail = normalizeIssueDetail({
      issue: { id: '1' } as never,
      comments: [comment('c1'), { ...comment('c2'), parentId: 'c1' }],
    });
    const next = updateDetailComment(detail, 'c2', (current) => ({
      ...current,
      reactions: toggleReaction(current.reactions, '🎉', 'u1'),
    }));
    expect(next.threads[0].replies[0].reactions).toEqual([
      { emoji: '🎉', count: 1, userIds: ['u1'] },
    ]);
    expect(next.threads[0].root.reactions).toBeUndefined();
  });
});

const row = (key: string, extra: Partial<UsageRow> = {}): UsageRow => ({
  key,
  name: key,
  runs: 1,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: null,
  ...extra,
});

describe('usage', () => {
  it('formats cost with "—" for an unpriced row', () => {
    expect(formatCost(null, 'en-US')).toBe('—');
    expect(formatCost(1.5, 'en-US')).toBe('$1.50');
    expect(formatCost(0.0042, 'en-US')).toBe('$0.0042');
    expect(formatCost(0, 'en-US')).toBe('$0.00');
  });

  it('formats token counts compactly', () => {
    expect(formatTokens(950, 'en-US')).toBe('950');
    expect(formatTokens(12_345, 'en-US')).toBe('12.3K');
    expect(formatTokens(4_500_000, 'en-US')).toBe('4.5M');
  });

  it('defaults to the last 30 days including today', () => {
    expect(defaultUsageRange(new Date(2026, 8, 27))).toEqual({
      from: '2026-08-29',
      to: '2026-09-27',
    });
    expect(readUsageGroup('model')).toBe('model');
    expect(readUsageGroup('bogus')).toBe('agent');
  });

  it('sums priced rows only and keeps the cost null when none is priced', () => {
    expect(sumUsage([row('a'), row('b')]).estimatedCost).toBeNull();
    const totals = sumUsage([row('a', { estimatedCost: 1 }), row('b')]);
    expect(totals.estimatedCost).toBe(1);
    expect(totals.runs).toBe(2);
    expect(totals.pricedRuns).toBe(1);
  });

  it('accepts the usage envelope with or without totals', () => {
    const rows = [row('a', { estimatedCost: 2 })];
    expect(
      normalizeUsage({ data: { rows, totals: row('t') } }).totals.key,
    ).toBe('t');
    expect(normalizeUsage({ rows }).totals.estimatedCost).toBe(2);
    expect(normalizeUsage({ data: rows }).rows).toEqual(rows);
  });

  it('orders heavy rows first, days by date, and finds one issue', () => {
    const rows = [
      row('cheap', { estimatedCost: 0.1 }),
      row('free'),
      row('dear', { estimatedCost: 3 }),
    ];
    expect(sortUsageRows(rows, 'agent').map((item) => item.key)).toEqual([
      'dear',
      'cheap',
      'free',
    ]);
    expect(
      sortUsageRows([row('2026-09-02'), row('2026-09-01')], 'day').map(
        (item) => item.key,
      ),
    ).toEqual(['2026-09-01', '2026-09-02']);
    expect(usageForIssue(rows, 'dear')?.estimatedCost).toBe(3);
    expect(usageForIssue(rows, 'none')).toBeNull();
  });
});
