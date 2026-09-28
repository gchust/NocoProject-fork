// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { normalizeComments } from '../../client/pages/np/detail-normalize.ts';
import {
  extractMentionedAgentIds,
  findMentionQuery,
  insertMention,
  parseMentionHref,
} from '../../client/pages/np/issues/mentions.ts';
import { computeTriggerPreview } from '../../client/pages/np/issues/trigger-preview.ts';
import type { IssueComment } from '../../client/pages/np/types.ts';

const agentExecutor = { type: 'agent', id: 'exec-1' } as const;
const noExecutor = { type: 'none', id: null } as const;

describe('computeTriggerPreview', () => {
  it('triggers nothing for a /note comment, even with mentions or an agent executor', () => {
    expect(
      computeTriggerPreview({
        content: '/note [@Coder](mention://agent/a1) remember this',
        replyTo: null,
        executor: agentExecutor,
      }),
    ).toEqual({ reason: 'note', agentIds: [] });
    expect(
      computeTriggerPreview({
        content: '  /note',
        replyTo: { authorType: 'agent', authorId: 'a2' },
        executor: agentExecutor,
      }).reason,
    ).toBe('note');
  });

  it('does not treat a word that merely starts with /note as a note', () => {
    expect(
      computeTriggerPreview({
        content: '/notes are elsewhere',
        replyTo: null,
        executor: agentExecutor,
      }),
    ).toEqual({ reason: 'executor', agentIds: ['exec-1'] });
  });

  it('triggers each explicitly mentioned agent once, ahead of the executor and reply rules', () => {
    expect(
      computeTriggerPreview({
        content:
          'Hey [@Coder](mention://agent/a1) and [@Reviewer](mention://agent/a2), also [@Coder](mention://agent/a1)',
        replyTo: { authorType: 'agent', authorId: 'a3' },
        executor: agentExecutor,
      }),
    ).toEqual({ reason: 'mention', agentIds: ['a1', 'a2'] });
  });

  it('routes a reply without mentions to the agent that wrote the replied comment', () => {
    expect(
      computeTriggerPreview({
        content: 'Thanks, please also update the docs',
        replyTo: { authorType: 'agent', authorId: 'a3' },
        executor: agentExecutor,
      }),
    ).toEqual({ reason: 'reply', agentIds: ['a3'] });
  });

  it('triggers nothing for a reply to a person, even when the executor is an agent', () => {
    expect(
      computeTriggerPreview({
        content: 'Agreed',
        replyTo: { authorType: 'user', authorId: 'u1' },
        executor: agentExecutor,
      }),
    ).toEqual({ reason: 'none', agentIds: [] });
  });

  it('routes a top-level comment without mentions to the agent executor', () => {
    expect(
      computeTriggerPreview({
        content: 'Please start',
        replyTo: null,
        executor: agentExecutor,
      }),
    ).toEqual({ reason: 'executor', agentIds: ['exec-1'] });
  });

  it('triggers nothing when the executor is a person or nobody', () => {
    for (const executor of [noExecutor, { type: 'user', id: 'u1' } as const]) {
      expect(
        computeTriggerPreview({ content: 'Hello', replyTo: null, executor }),
      ).toEqual({ reason: 'none', agentIds: [] });
    }
  });

  it('ignores an @name that is not a mention link', () => {
    expect(
      computeTriggerPreview({
        content: '@Coder please look',
        replyTo: null,
        executor: noExecutor,
      }),
    ).toEqual({ reason: 'none', agentIds: [] });
  });
});

describe('agent mentions', () => {
  it('extracts mentioned agent ids in order without duplicates', () => {
    expect(
      extractMentionedAgentIds(
        '[@B](mention://agent/2) [@A](mention://agent/1) [@B](mention://agent/2)',
      ),
    ).toEqual(['2', '1']);
  });

  it('opens a query only for an @ at the start or after whitespace', () => {
    expect(findMentionQuery('@Co', 3)).toEqual({ start: 0, query: 'Co' });
    expect(findMentionQuery('ask @Re', 7)).toEqual({ start: 4, query: 'Re' });
    expect(findMentionQuery('mail a@b', 8)).toBeNull();
    expect(findMentionQuery('ask @Re now', 11)).toBeNull();
    expect(findMentionQuery('no mention', 10)).toBeNull();
  });

  it('replaces the typed @query with the mention link and a trailing space', () => {
    const text = 'Please @Cod review';
    const caret = 'Please @Cod'.length;
    const result = insertMention(text, caret, {
      id: '1234567890',
      name: 'Claude Coder',
    });
    expect(result.text).toBe(
      'Please [@Claude Coder](mention://agent/1234567890) review',
    );
    expect(result.caret).toBe(
      'Please [@Claude Coder](mention://agent/1234567890) '.length,
    );
    expect(extractMentionedAgentIds(result.text)).toEqual(['1234567890']);
  });

  it('keeps the link label intact when the agent name contains brackets', () => {
    const result = insertMention('@', 1, { id: '7', name: 'Bot [beta]' });
    expect(result.text).toBe('[@Bot beta](mention://agent/7) ');
    expect(extractMentionedAgentIds(result.text)).toEqual(['7']);
  });

  it('parses only mention hrefs', () => {
    expect(parseMentionHref('mention://agent/42')).toBe('42');
    expect(parseMentionHref('https://example.com')).toBeNull();
    expect(parseMentionHref(undefined)).toBeNull();
  });
});

describe('normalizeComments', () => {
  const comment = (
    id: string,
    parentId: string | null,
    createdAt: string,
    extra: Partial<IssueComment> = {},
  ): IssueComment => ({
    id,
    parentId,
    createdAt,
    authorType: 'user',
    authorId: 'u1',
    content: id,
    ...extra,
  });

  it('groups a flat list into threads with every descendant flattened in time order', () => {
    const threads = normalizeComments([
      comment('r2', null, '2026-01-02T00:00:00Z'),
      comment('c2', 'c1', '2026-01-01T03:00:00Z'),
      comment('r1', null, '2026-01-01T00:00:00Z'),
      comment('c1', 'r1', '2026-01-01T01:00:00Z'),
    ]);
    expect(threads.map((thread) => thread.root.id)).toEqual(['r1', 'r2']);
    expect(threads[0].replies.map((reply) => reply.id)).toEqual(['c1', 'c2']);
    expect(threads[1].replies).toEqual([]);
  });

  it('accepts a nested tree', () => {
    const threads = normalizeComments([
      comment('r1', null, '2026-01-01T00:00:00Z', {
        replies: [
          comment('c1', null, '2026-01-01T01:00:00Z', {
            children: [comment('c2', null, '2026-01-01T02:00:00Z')],
          }),
        ],
      }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((reply) => reply.id)).toEqual(['c1', 'c2']);
    expect(threads[0].replies[1].parentId).toBe('c1');
  });

  it('keeps a reply whose parent is missing as a thread of its own', () => {
    const threads = normalizeComments([
      comment('orphan', 'gone', '2026-01-01T00:00:00Z'),
    ]);
    expect(threads.map((thread) => thread.root.id)).toEqual(['orphan']);
  });
});
