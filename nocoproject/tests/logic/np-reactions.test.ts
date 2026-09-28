// @vitest-environment node
/**
 * Reactions and thread resolution (iteration-2 contract §F) on a real PostgreSQL: the fixed emoji set, idempotent
 * add / remove, visibility, root-only resolve with activities, the detail view, and the agent comment view's
 * `resolved` flag and `excludeResolved` filter.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { Hono } from 'hono';

import { createReactionRoutes } from '../../server/modules/collaboration/reaction.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { CommentForAgentV2 } from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  CAROL,
  agentApi,
  buildServices,
  claimOne,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_reactions');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-reactions] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
});

async function thread() {
  const issue = await services.issues.create(ALICE, { title: 'Discuss' });
  const root = (
    await services.comments.create(ALICE, issue.id, { content: '/note Root' })
  ).comment;
  const reply = (
    await services.comments.create(BOB, issue.id, {
      content: '/note Reply',
      parentId: root.id,
    })
  ).comment;
  return { issue, root, reply };
}

describe.skipIf(!db)('reactions and thread resolution (PostgreSQL)', () => {
  it('adds and removes reactions from the fixed set, idempotently', async () => {
    const { issue, root } = await thread();
    await expect(
      services.reactions.add(ALICE, root.id, '💩'),
    ).rejects.toMatchObject({ code: 'INVALID_EMOJI' });
    await services.reactions.add(ALICE, root.id, '👍');
    await services.reactions.add(ALICE, root.id, '👍');
    await services.reactions.add(BOB, root.id, '🎉');
    const reactions = await services.reactions.add(BOB, root.id, '👍');
    expect(reactions).toEqual([
      { emoji: '👍', count: 2, userIds: [ALICE.id, BOB.id] },
      { emoji: '🎉', count: 1, userIds: [BOB.id] },
    ]);
    expect(await services.reactions.remove(ALICE, root.id, '👍')).toEqual([
      { emoji: '👍', count: 1, userIds: [BOB.id] },
      { emoji: '🎉', count: 1, userIds: [BOB.id] },
    ]);
    await services.reactions.remove(ALICE, root.id, '👍');
    const detail = await services.issueQueries.detail(ALICE, issue.id);
    expect(
      detail.comments.find((item) => item.id === root.id)?.reactions,
    ).toHaveLength(2);
  });

  it('hides comments on issues the member cannot see', async () => {
    const project = await services.projects.create(ALICE, {
      name: 'Secret',
      visibility: 'members',
    });
    const issue = await services.issues.create(ALICE, {
      title: 'Hidden',
      projectId: project.id,
    });
    const root = (
      await services.comments.create(ALICE, issue.id, { content: '/note x' })
    ).comment;
    await expect(
      services.reactions.add(CAROL, root.id, '👀'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      services.reactions.resolve(CAROL, root.id, true),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      services.reactions.add(CAROL, 'missing', '👀'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('resolves and unresolves thread roots only, with activities', async () => {
    const { issue, root, reply } = await thread();
    await expect(
      services.reactions.resolve(BOB, reply.id, true),
    ).rejects.toMatchObject({ code: 'NOT_THREAD_ROOT' });
    const resolved = await services.reactions.resolve(BOB, root.id, true);
    expect(resolved).toMatchObject({
      commentId: root.id,
      resolvedById: BOB.id,
    });
    expect(resolved.resolvedAt).not.toBeNull();
    await services.reactions.resolve(BOB, root.id, true);
    let detail = await services.issueQueries.detail(ALICE, issue.id);
    expect(detail.comments.find((item) => item.id === root.id)).toMatchObject({
      resolvedByName: 'Bob',
    });
    expect(
      detail.activities.filter((item) => item.action === 'thread_resolved'),
    ).toHaveLength(1);
    expect(
      (await services.reactions.resolve(ALICE, root.id, false)).resolvedAt,
    ).toBeNull();
    detail = await services.issueQueries.detail(ALICE, issue.id);
    expect(detail.activities.map((item) => item.action)).toContain(
      'thread_unresolved',
    );
    expect(
      detail.comments.find((item) => item.id === root.id)?.resolvedAt,
    ).toBeNull();
  });

  it('marks resolved threads for agents and can leave them out', async () => {
    const fixture = await registerRuntime(services, ALICE);
    const agentId = await createAgent(
      services,
      ALICE,
      fixture.runtimeId,
      'Dev',
    );
    const issue = await services.issues.create(ALICE, {
      title: 'Agent',
      executor: { type: 'agent', id: agentId },
    });
    const done = (
      await services.comments.create(ALICE, issue.id, {
        content: '/note old thread',
      })
    ).comment;
    const open = (
      await services.comments.create(ALICE, issue.id, {
        content: '/note open thread',
      })
    ).comment;
    await services.reactions.resolve(ALICE, done.id, true);
    const claimed = await claimOne(services, ALICE, fixture);
    const call = agentApi(services, claimed!.token);
    const all = (await call('GET', `/issues/${issue.id}/comments`)).body
      .data as CommentForAgentV2[];
    expect(all.map((item) => [item.id, item.resolved])).toEqual([
      [done.id, true],
      [open.id, false],
    ]);
    const unresolved = (
      await call('GET', `/issues/${issue.id}/comments?excludeResolved=1`)
    ).body.data as CommentForAgentV2[];
    expect(unresolved.map((item) => item.id)).toEqual([open.id]);
    const threadAsked = (
      await call(
        'GET',
        `/issues/${issue.id}/comments?excludeResolved=1&thread=${done.id}`,
      )
    ).body.data as CommentForAgentV2[];
    expect(threadAsked.map((item) => item.id)).toEqual([done.id]);
  });

  it('serves reactions over HTTP with the emoji URL-encoded in the path', async () => {
    const { root } = await thread();
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('auth' as never, { user: { id: BOB.id } } as never);
      await next();
    });
    app.route('/np/comments', createReactionRoutes(services.reactions));
    const added = await app.request(`/np/comments/${root.id}/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emoji: '🚀' }),
    });
    expect(added.status).toBe(200);
    const removed = await app.request(
      `/np/comments/${root.id}/reactions/${encodeURIComponent('🚀')}`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ data: [] });
    const bad = await app.request(`/np/comments/${root.id}/reactions/%E0`, {
      method: 'DELETE',
    });
    expect(bad.status).toBe(400);
  });
});
