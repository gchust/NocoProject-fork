import { describe, expect, it } from 'vitest';

import {
  DETAIL_POLL_MS,
  detailRefetchInterval,
  normalizeIssueDetail,
  withComment,
} from '../../client/pages/np/detail-normalize.ts';
import {
  activityChange,
  activityLabel,
  buildTimeline,
} from '../../client/pages/np/issues/detail/timeline.ts';
import { mergeRunEvents } from '../../client/pages/np/issues/detail/use-run-events.ts';
import type { RunEvent } from '../../client/pages/np/types.ts';

describe('issue detail normalization', () => {
  const issue = {
    id: '1',
    identifier: 'NP-1',
    title: 'T',
    description: null,
    statusKey: 'todo',
    priority: 'none',
    ownerUserId: 'u1',
    executorType: 'none',
    executorId: null,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as const;

  it('accepts the issue nested under `issue` or spread at the top level', () => {
    expect(normalizeIssueDetail({ issue }).issue.identifier).toBe('NP-1');
    expect(normalizeIssueDetail({ ...issue }).issue.identifier).toBe('NP-1');
  });

  it('falls back to the Phase 0 status catalog and orders runs newest first', () => {
    const detail = normalizeIssueDetail({
      issue,
      runs: [
        {
          id: 'a',
          agentId: 'x',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'b',
          agentId: 'x',
          status: 'running',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    expect(detail.statusCatalog.map((entry) => entry.key)).toEqual([
      'backlog',
      'todo',
      'analysis',
      'proposal_review',
      'in_progress',
      'in_review',
      'blocked',
      'done',
      'cancelled',
    ]);
    expect(detail.runs.map((run) => run.id)).toEqual(['b', 'a']);
  });
});

describe('timeline', () => {
  it('interleaves threads, activities and runs chronologically', () => {
    const entries = buildTimeline({
      threads: [
        {
          root: {
            id: 'c1',
            authorType: 'user',
            authorId: 'u1',
            content: 'x',
            parentId: null,
            createdAt: '2026-01-01T02:00:00Z',
          },
          replies: [],
        },
      ],
      activities: [
        {
          id: 'a1',
          actorType: 'user',
          actorId: 'u1',
          action: 'issue.created',
          createdAt: '2026-01-01T01:00:00Z',
        },
      ],
      runs: [
        {
          id: 'r1',
          agentId: 'x',
          status: 'queued',
          createdAt: '2026-01-01T03:00:00Z',
        },
      ],
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'activity:a1',
      'thread:c1',
      'run:r1',
    ]);
  });

  it('reads activity actions by keyword', () => {
    expect(activityLabel('issue.created')).toBe('created');
    expect(activityLabel('status.changed')).toBe('statusChanged');
    expect(activityLabel('issue.statusChanged')).toBe('statusChanged');
    expect(activityLabel('executor_changed')).toBe('executorChanged');
    expect(activityLabel('something.else')).toBe('updated');
    expect(activityChange({ from: 'todo', to: 'in_progress' })).toEqual({
      from: 'todo',
      to: 'in_progress',
    });
    expect(activityChange(null)).toEqual({ from: null, to: null });
  });
});

describe('mergeRunEvents', () => {
  const event = (seq: number, content = String(seq)): RunEvent => ({
    seq,
    type: 'text',
    content,
    at: '2026-01-01T00:00:00Z',
  });

  it('appends new events in sequence order and ignores repeated sequence numbers', () => {
    const merged = mergeRunEvents(
      [event(1), event(2)],
      [event(4), event(2, 'again'), event(3)],
    );
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(merged).toHaveLength(4);
  });

  it('returns the same list for an empty batch', () => {
    const current = [event(1)];
    expect(mergeRunEvents(current, [])).toBe(current);
  });
});

describe('detail after posting a comment', () => {
  const issue = {
    id: '1',
    identifier: 'NP-1',
    title: 'T',
    description: null,
    statusKey: 'todo',
    priority: 'none',
    ownerUserId: 'u1',
    executorType: 'none',
    executorId: null,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as const;
  const comment = (id: string, parentId: string | null, at: string) => ({
    id,
    authorType: 'user' as const,
    authorId: 'u1',
    content: id,
    parentId,
    createdAt: at,
  });

  it('adds a new top-level comment and a reply into its thread, once', () => {
    const detail = normalizeIssueDetail({
      issue,
      comments: [comment('c1', null, '2026-01-01T00:00:00Z')],
    });
    const withRoot = withComment(
      detail,
      comment('c2', null, '2026-01-02T00:00:00Z'),
    );
    expect(withRoot.threads.map((thread) => thread.root.id)).toEqual([
      'c1',
      'c2',
    ]);
    const withReply = withComment(
      withRoot,
      comment('c3', 'c1', '2026-01-03T00:00:00Z'),
    );
    expect(withReply.threads[0]?.replies.map((reply) => reply.id)).toEqual([
      'c3',
    ]);
    expect(
      withComment(withReply, comment('c3', 'c1', '2026-01-03T00:00:00Z')),
    ).toBe(withReply);
  });

  it('polls only while a run is queued, dispatched or running', () => {
    const run = (status: string) => ({
      id: status,
      agentId: 'a',
      status,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const detailWith = (status: string) =>
      normalizeIssueDetail({ issue, runs: [run(status)] as never });
    expect(detailRefetchInterval(undefined)).toBe(false);
    expect(detailRefetchInterval(normalizeIssueDetail({ issue }))).toBe(false);
    for (const status of ['queued', 'dispatched', 'running'])
      expect(detailRefetchInterval(detailWith(status))).toBe(DETAIL_POLL_MS);
    for (const status of ['deferred', 'completed', 'failed', 'cancelled'])
      expect(detailRefetchInterval(detailWith(status))).toBe(false);
  });
});
