import { ApiClientError } from '@nocobase/app-client';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_METRIC_THRESHOLDS,
  flattenIssuePages,
  mergeColumnPages,
  metricStatus,
  metricValue,
  normalizeActivityPage,
  normalizeBoardColumn,
  normalizeBoardV3,
  normalizeIssuePage,
  normalizeMetrics,
} from '../../client/pages/np/api-iter3.js';
import {
  isKnowledgeConflict,
  normalizeKnowledgeDetail,
  slugify,
} from '../../client/pages/np/api-knowledge.js';
import { normalizeIssueDetail } from '../../client/pages/np/detail-normalize.js';
import { mergeActivities } from '../../client/pages/np/issues/detail/timeline.js';
import {
  formatDuration,
  formatMetric,
  metricGroups,
  warnCount,
} from '../../client/pages/np/reports/metrics-model.js';
import type {
  IssueActivity,
  IssueListItem,
} from '../../client/pages/np/types.js';

function issue(id: string, statusKey = 'todo'): IssueListItem {
  return {
    id,
    identifier: `NP-${id}`,
    title: `Issue ${id}`,
    statusKey,
    priority: 'none',
    ownerUserId: null,
    executorType: 'none',
    executorId: null,
    updatedAt: '2026-09-27T00:00:00.000Z',
  };
}

function activity(id: string, createdAt: string): IssueActivity {
  return {
    id,
    actorType: 'user',
    actorId: 'u1',
    action: 'status_changed',
    createdAt,
  };
}

describe('issue pages (§D)', () => {
  it('reads { data, nextCursor }, a nested envelope and a bare list', () => {
    expect(
      normalizeIssuePage({ data: [issue('1')], nextCursor: 'c2' }),
    ).toEqual({ data: [issue('1')], nextCursor: 'c2' });
    expect(
      normalizeIssuePage({ data: { data: [issue('1')], nextCursor: 'c3' } }),
    ).toEqual({ data: [issue('1')], nextCursor: 'c3' });
    // An iteration 2 server returns the whole list: one last page.
    expect(normalizeIssuePage([issue('1')])).toEqual({
      data: [issue('1')],
      nextCursor: null,
    });
    expect(normalizeIssuePage({ data: [issue('1')] })).toEqual({
      data: [issue('1')],
      nextCursor: null,
    });
    expect(normalizeIssuePage({ data: [], nextCursor: '' }).nextCursor).toBe(
      null,
    );
    expect(normalizeIssuePage(null)).toEqual({ data: [], nextCursor: null });
  });

  it('flattens loaded pages without repeating an issue that moved between them', () => {
    expect(
      flattenIssuePages([
        { data: [issue('1'), issue('2')], nextCursor: 'c' },
        { data: [issue('2'), issue('3')], nextCursor: null },
      ]).map((row) => row.id),
    ).toEqual(['1', '2', '3']);
    expect(flattenIssuePages(undefined)).toEqual([]);
  });

  it('reads board groups with hasMore / nextCursor and treats old groups as complete', () => {
    expect(
      normalizeBoardV3({
        data: {
          groups: [
            {
              statusKey: 'todo',
              issues: [issue('1')],
              hasMore: true,
              nextCursor: 'c1',
            },
            { statusKey: 'done', issues: [] },
          ],
        },
      }),
    ).toEqual([
      {
        statusKey: 'todo',
        issues: [issue('1')],
        hasMore: true,
        nextCursor: 'c1',
      },
      { statusKey: 'done', issues: [], hasMore: false, nextCursor: null },
    ]);
    // A flat list (a server ignoring `view`) is grouped by status.
    expect(
      normalizeBoardV3({ data: [issue('1', 'todo'), issue('2', 'done')] }).map(
        (group) => [group.statusKey, group.hasMore],
      ),
    ).toEqual([
      ['todo', false],
      ['done', false],
    ]);
  });

  it('reads one column page as a one-group board or as a plain page', () => {
    expect(
      normalizeBoardColumn(
        {
          groups: [
            { statusKey: 'todo', issues: [issue('9')], nextCursor: null },
          ],
        },
        'todo',
      ),
    ).toEqual({ data: [issue('9')], nextCursor: null });
    expect(
      normalizeBoardColumn({ data: [issue('9')], nextCursor: 'n' }, 'todo'),
    ).toEqual({ data: [issue('9')], nextCursor: 'n' });
    expect(
      mergeColumnPages(
        [issue('1')],
        [{ data: [issue('1'), issue('2')], nextCursor: null }],
      ).map((row) => row.id),
    ).toEqual(['1', '2']);
  });

  it('pages activities and merges them with the detail in order, once each', () => {
    expect(
      normalizeActivityPage({
        data: [activity('a1', '2026-01-01')],
        nextCursor: 'x',
      }),
    ).toEqual({ data: [activity('a1', '2026-01-01')], nextCursor: 'x' });
    expect(normalizeActivityPage([]).nextCursor).toBeNull();
    expect(
      mergeActivities(
        [activity('a1', '2026-01-01'), activity('a2', '2026-01-02')],
        [activity('a2', '2026-01-02'), activity('a3', '2026-01-03')],
      ).map((entry) => entry.id),
    ).toEqual(['a1', 'a2', 'a3']);
    expect(
      normalizeIssueDetail({
        issue: { ...issue('1'), description: null, revision: 1, createdAt: '' },
        activitiesNextCursor: 'older',
      }).activitiesNextCursor,
    ).toBe('older');
    expect(
      normalizeIssueDetail({
        issue: { ...issue('1'), description: null, revision: 1, createdAt: '' },
      }).activitiesNextCursor,
    ).toBeNull();
  });
});

describe('metrics (§C)', () => {
  it('reads a bare number or { value, definition }', () => {
    expect(metricValue(0.4)).toBe(0.4);
    expect(metricValue({ value: 12, definition: 'x' })).toBe(12);
    expect(metricValue(null)).toBeNull();
    expect(metricValue(Number.NaN)).toBeNull();
    expect(metricValue(undefined)).toBeNull();
  });

  it('computes a status from the threshold when the server sends none', () => {
    const report = { thresholds: DEFAULT_METRIC_THRESHOLDS, statuses: {} };
    expect(metricStatus('share', 0.6, report)).toBe('ok');
    expect(metricStatus('share', 0.3, report)).toBe('warn');
    expect(metricStatus('claimLatencyP50Ms', 2500, report)).toBe('ok');
    expect(metricStatus('claimLatencyP50Ms', 4000, report)).toBe('warn');
    expect(metricStatus('lostRuns', 0, report)).toBe('ok');
    expect(metricStatus('lostRuns', 1, report)).toBe('warn');
    expect(metricStatus('share', null, report)).toBe('n/a');
    expect(metricStatus('runs', 10, report)).toBe('n/a');
    // The server's status wins; it keys the `share` metric by its threshold name.
    expect(
      metricStatus('share', 0.3, {
        thresholds: DEFAULT_METRIC_THRESHOLDS,
        statuses: { aiShare: 'ok' },
      }),
    ).toBe('ok');
  });

  it('fills a partial report and lays out the six groups', () => {
    const report = normalizeMetrics({
      data: {
        aiShare: { share: 0.2, deliveredByAgent: 2, deliveredTotal: 10 },
        reliability: { lostRuns: { value: 1, definition: 'stuck > 3h' } },
        thresholds: { aiShare: 0.1 },
      },
    });
    expect(report.thresholds.aiShare).toBe(0.1);
    expect(report.thresholds.lostRuns).toBe(0);
    expect(report.cost.byAgent).toEqual([]);
    const groups = metricGroups(report);
    expect(groups.map((group) => group.key)).toEqual([
      'adoption',
      'aiShare',
      'trust',
      'reliability',
      'cost',
      'humanLoad',
    ]);
    const share = groups[1].items.find((item) => item.key === 'share');
    expect(share).toMatchObject({ value: 0.2, status: 'ok', kind: 'percent' });
    const lost = groups[3].items.find((item) => item.key === 'lostRuns');
    expect(lost).toMatchObject({
      value: 1,
      status: 'warn',
      definition: 'stuck > 3h',
    });
    expect(warnCount(groups)).toBe(1);
  });

  it('formats percentages, durations and missing values', () => {
    expect(formatMetric('percent', 0.525, 'en-US')).toBe('52.5%');
    expect(formatMetric('count', null, 'en-US')).toBe('—');
    expect(formatDuration(850, 'en-US')).toMatch(/850/u);
    expect(formatDuration(2400, 'en-US')).toMatch(/2\.4/u);
    expect(formatDuration(3 * 3_600_000, 'en-US')).toMatch(/3/u);
  });
});

describe('knowledge (§B)', () => {
  it('reads the detail envelope, keeps only pending proposals, newest versions first', () => {
    const detail = normalizeKnowledgeDetail({
      data: {
        doc: {
          id: 'k1',
          projectId: null,
          title: 'Testing',
          slug: 'testing',
          summary: null,
          version: 3,
          updatedAt: '2026-09-27',
        },
        versions: [
          { version: 1, title: 'Testing', authorType: 'user', createdAt: 'a' },
          { version: 3, title: 'Testing', authorType: 'agent', createdAt: 'c' },
        ],
        proposals: [
          { id: 'p1', status: 'pending' },
          { id: 'p2', status: 'accepted' },
        ],
      },
    });
    expect(detail.doc.content).toBe('');
    expect(detail.versions.map((version) => version.version)).toEqual([3, 1]);
    expect(detail.proposals.map((proposal) => proposal.id)).toEqual(['p1']);
  });

  it('recognizes the version conflict', () => {
    const conflict = new ApiClientError('conflict', {
      status: 409,
      code: 'KNOWLEDGE_VERSION_CONFLICT',
      method: 'PATCH',
      url: '/api/np/knowledge/k1',
    });
    const forbidden = new ApiClientError('no', {
      status: 403,
      code: 'FORBIDDEN',
      method: 'PATCH',
      url: '/api/np/knowledge/k1',
    });
    expect(isKnowledgeConflict(conflict)).toBe(true);
    expect(isKnowledgeConflict(forbidden)).toBe(false);
    expect(isKnowledgeConflict(new Error('offline'))).toBe(false);
  });

  it('derives a slug from a title', () => {
    expect(slugify('Coding Conventions & Tests!')).toBe(
      'coding-conventions-tests',
    );
    expect(slugify('  ')).toBe('');
  });
});
