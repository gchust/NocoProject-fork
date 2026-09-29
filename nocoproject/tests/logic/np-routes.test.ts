// @vitest-environment node
/**
 * The NocoProject route contributions, built through their real factories with test doubles: authentication
 * boundaries (anonymous 401, run token 403 on the browser and daemon surfaces), daemon run ownership, run-token
 * authentication on the agent API, domain error mapping, and (iteration 2) the 202 answers of gated status writes,
 * the agent's pull request link and the new browser prefixes.
 */
import { describe, expect, it } from 'vitest';

import { npAgentRoutes } from '../../server/routes/np-agent.ts';
import { npApiRoutes } from '../../server/routes/np-api.ts';
import { npDaemonRoutes } from '../../server/routes/np-daemon.ts';
import routes from '../../server/routes/index.ts';
import { build, json, signedIn, withRunToken } from './np-routes-harness.ts';

describe('NocoProject route registration', () => {
  it('registers the three contributions under /api', () => {
    expect(routes).toEqual(
      expect.arrayContaining([npApiRoutes, npDaemonRoutes, npAgentRoutes]),
    );
    for (const contribution of [npApiRoutes, npDaemonRoutes, npAgentRoutes])
      expect(contribution.scope).toBe('api');
  });
});

describe('browser API /np/*', () => {
  it.each([
    '/np/me',
    '/np/me/preferences',
    '/np/projects',
    '/np/issues',
    '/np/issues/NP-1',
    '/np/agents',
    '/np/runtimes',
    '/np/runs/r1',
    '/np/members',
    '/np/workflows',
    '/np/workflows/proposals/p1',
    '/np/workflows/default/revisions',
    '/np/labels',
    '/np/inbox',
    '/np/inbox/unread-count',
    '/np/inbox/pending-count',
  ])('answers 401 to an anonymous GET %s', async (path) => {
    const { router } = await build(npApiRoutes);
    const response = await router.request(path);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('answers 403 to a run token, even alongside a session', async () => {
    const { router } = await build(npApiRoutes);
    for (const headers of [withRunToken, { ...withRunToken, ...signedIn }]) {
      const response = await router.request('/np/issues', { headers });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: 'RUN_TOKEN_FORBIDDEN',
      });
    }
  });

  it('keeps workflow template writes away from anonymous callers and run tokens', async () => {
    const { router } = await build(npApiRoutes);
    const body = JSON.stringify({ definition: {}, revision: 1 });
    const put = (headers: Record<string, string>) =>
      router.request('/np/workflows/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    expect((await put({})).status).toBe(401);
    expect((await put(withRunToken)).status).toBe(403);
    const accept = await router.request('/np/workflows/proposals/p1/accept', {
      method: 'POST',
      headers: withRunToken,
    });
    expect(accept.status).toBe(403);
  });

  it('returns the signed-in user from /np/me', async () => {
    const { router } = await build(npApiRoutes);
    const response = await router.request('/np/me', { headers: signedIn });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { userId: 'u1', name: 'User u1' },
    });
  });

  it('reads and changes the signed-in member’s own preferences (NP-108)', async () => {
    const { router, doubles } = await build(npApiRoutes);
    const read = await router.request('/np/me/preferences', {
      headers: signedIn,
    });
    await expect(read.json()).resolves.toEqual({ data: { inboxChime: true } });
    expect(doubles.members.preferences).toHaveBeenCalledWith('u1');

    const patched = await router.request('/np/me/preferences', {
      method: 'PATCH',
      headers: { ...signedIn, 'content-type': 'application/json' },
      body: JSON.stringify({ inboxChime: false }),
    });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toEqual({
      data: { inboxChime: false },
    });
    expect(doubles.members.updatePreferences).toHaveBeenCalledWith('u1', {
      inboxChime: false,
    });
  });

  it('passes list filters and maps domain conflicts to 409', async () => {
    const { router, doubles } = await build(npApiRoutes);
    const list = await router.request(
      '/np/issues?statusKey=todo&q=bug&limit=20&cursor=abc',
      { headers: signedIn },
    );
    expect(list.status).toBe(200);
    // Iteration 3 §D: one keyset page, `nextCursor` beside `data`.
    await expect(list.json()).resolves.toEqual({
      data: [{ id: 'i1', identifier: 'NP-1' }],
      nextCursor: null,
    });
    expect(doubles.issueQueries.page).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user', id: 'u1' }),
      {
        statusKey: 'todo',
        projectId: null,
        q: 'bug',
        labelId: null,
        ownerUserId: null,
        executorId: null,
        parentIssueId: null,
      },
      { cursor: 'abc', limit: 20, sort: null },
    );
    // Every signed-in request bootstraps the caller's members row first.
    expect(doubles.members.ensure).toHaveBeenCalledWith('u1');

    const patch = await router.request('/np/issues/i1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...signedIn },
      body: JSON.stringify({ title: 'x', revision: 1 }),
    });
    expect(patch.status).toBe(409);
    await expect(patch.json()).resolves.toEqual({
      code: 'REVISION_CONFLICT',
      message: 'Issue is at revision 3.',
    });
  });

  it('rejects a non-JSON body with 400', async () => {
    const { router } = await build(npApiRoutes);
    const response = await router.request('/np/issues/i1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedIn },
      body: 'not json',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_JSON',
    });
  });

  it('passes the caller as the comment author', async () => {
    const { router, doubles } = await build(npApiRoutes);
    const response = await router.request(
      '/np/issues/NP-1/comments',
      json({ content: 'hi' }, signedIn),
    );
    expect(response.status).toBe(201);
    expect(doubles.comments.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user', id: 'u1' }),
      'NP-1',
      { content: 'hi' },
    );
  });

  it('answers the inbox with unread counts beside data', async () => {
    const { router, doubles } = await build(npApiRoutes);
    const list = await router.request('/np/inbox?kind=decision', {
      headers: signedIn,
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({
      data: [],
      unread: { decision: 0, info: 0 },
      nextCursor: null,
    });
    expect(doubles.inbox.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user', id: 'u1' }),
      {
        kind: 'decision',
        archived: null,
        resolved: null,
        issueId: null,
        cursor: null,
      },
    );
    const count = await router.request('/np/inbox/unread-count', {
      headers: signedIn,
    });
    await expect(count.json()).resolves.toEqual({
      data: { decision: 1, info: 2 },
    });
    const pending = await router.request('/np/inbox/pending-count', {
      headers: signedIn,
    });
    await expect(pending.json()).resolves.toEqual({ data: { decision: 3 } });
    expect(doubles.inbox.pendingCount).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user', id: 'u1' }),
    );
  });
});

describe('daemon API /np/daemon/*', () => {
  it('answers 401 to anonymous and 403 to a run token', async () => {
    const { router } = await build(npDaemonRoutes);
    expect((await router.request('/np/daemon/register', json({}))).status).toBe(
      401,
    );
    expect(
      (await router.request('/np/daemon/runs/claim', json({}))).status,
    ).toBe(401);
    expect((await router.request('/np/daemon/runs/mine/status')).status).toBe(
      401,
    );
    const tokenResponse = await router.request(
      '/np/daemon/heartbeat',
      json({}, withRunToken),
    );
    expect(tokenResponse.status).toBe(403);
  });

  it('only lets the owner of the run runtime act on a run', async () => {
    const { router, doubles } = await build(npDaemonRoutes);
    expect(
      (
        await router.request('/np/daemon/runs/mine/status', {
          headers: signedIn,
        })
      ).status,
    ).toBe(200);
    const theirs = await router.request('/np/daemon/runs/theirs/status', {
      headers: signedIn,
    });
    expect(theirs.status).toBe(403);
    await expect(theirs.json()).resolves.toMatchObject({
      code: 'RUN_NOT_OWNED',
    });
    expect(
      (
        await router.request('/np/daemon/runs/missing/status', {
          headers: signedIn,
        })
      ).status,
    ).toBe(404);
    expect(doubles.runtimes.runAccess).toHaveBeenCalledWith('theirs', 'u1');
  });

  it('claims for the key owner with the public server URL', async () => {
    const { router, doubles } = await build(npDaemonRoutes);
    const body = { daemonId: 'd1', slots: [{ runtimeId: 'rt1', free: 2 }] };
    const response = await router.request(
      'http://localhost/np/daemon/runs/claim',
      json(body, signedIn),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { runs: [] } });
    expect(doubles.claims.claim).toHaveBeenCalledWith(
      'u1',
      body,
      'http://localhost/main',
    );
    expect(doubles.runtimes.runAccess).not.toHaveBeenCalled();
  });
});

describe('agent API /np/agent/*', () => {
  it('answers 401 without a run token, with a session, or with an unknown token', async () => {
    const { router } = await build(npAgentRoutes);
    expect((await router.request('/np/agent/context')).status).toBe(401);
    expect((await router.request('/np/agent/workflows')).status).toBe(401);
    expect(
      (await router.request('/np/agent/context', { headers: signedIn })).status,
    ).toBe(401);
    const unknown = await router.request('/np/agent/context', {
      headers: { authorization: `Bearer npr_${'b'.repeat(40)}` },
    });
    expect(unknown.status).toBe(401);
    await expect(unknown.json()).resolves.toMatchObject({
      code: 'INVALID_RUN_TOKEN',
    });
  });

  it('serves the run context for a valid token', async () => {
    const { router } = await build(npAgentRoutes);
    const response = await router.request('/np/agent/context', {
      headers: withRunToken,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { run: { id: 'r1' } },
    });
  });

  it('writes comments as the run agent and only to the run issue', async () => {
    const { router, doubles } = await build(npAgentRoutes);
    const ok = await router.request(
      '/np/agent/issues/NP-1/comments',
      json({ content: 'done' }, withRunToken),
    );
    expect(ok.status).toBe(201);
    expect(doubles.comments.create).toHaveBeenCalledWith(
      { type: 'agent', id: 'a1', runId: 'r1' },
      'i1',
      {
        content: 'done',
      },
    );
    const other = await router.request(
      '/np/agent/issues/i2/status',
      json({ statusKey: 'in_review' }, withRunToken),
    );
    expect(other.status).toBe(403);
    await expect(other.json()).resolves.toMatchObject({
      code: 'ISSUE_NOT_IN_RUN',
    });
  });

  it('creates sub-issues and removes dependencies the CLI way', async () => {
    const { router, doubles } = await build(npAgentRoutes);
    const created = await router.request(
      '/np/agent/issues',
      json({ title: 'Child', executor: 'self' }, withRunToken),
    );
    expect(created.status).toBe(201);
    expect(doubles.agentIssues.create).toHaveBeenCalledWith(
      { runId: 'r1', agentId: 'a1', actorUserId: 'u1', issueId: 'i1' },
      { title: 'Child', executor: 'self' },
    );
    const removed = await router.request(
      '/np/agent/issues/NP-2/dependencies?dependsOnIssueId=i7&type=blockedBy',
      { method: 'DELETE', headers: withRunToken },
    );
    expect(removed.status).toBe(200);
    expect(doubles.agentIssues.removeDependency).toHaveBeenCalledWith(
      { runId: 'r1', agentId: 'a1', actorUserId: 'u1', issueId: 'i1' },
      'NP-2',
      'i7',
      'blockedBy',
    );
  });

  it('does not leak its middleware onto /np/agents', async () => {
    const { router } = await build(npAgentRoutes);
    // Not a route of this contribution: no run-token 401 from the /np/agent guard.
    expect((await router.request('/np/agents')).status).toBe(404);
  });
});
