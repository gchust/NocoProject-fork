// @vitest-environment node
/**
 * Iteration 2 routes through the real route factories with test doubles (`np-routes-harness.ts`): the new browser
 * prefixes answer 401 to anonymous callers, gated status writes answer 202 on both surfaces, runs of invisible
 * issues are 404, the webhook URL follows the request origin and base path, and the agent's pull request link
 * answers 201 / 200 / 403.
 */
import { describe, expect, it } from 'vitest';

import { npAgentRoutes } from '../../server/routes/np-agent.ts';
import { npApiRoutes } from '../../server/routes/np-api.ts';
import {
  PENDING,
  build,
  json,
  signedIn,
  withRunToken,
} from './np-routes-harness.ts';

describe('iteration 2 browser routes', () => {
  it.each([
    '/np/integrations/github',
    '/np/approvals',
    '/np/intake/batches',
    '/np/skills',
    '/np/usage',
    '/np/settings',
    '/np/issues/NP-1/pull-requests',
    '/np/issues/NP-1/runs',
    '/np/agents/a1/env',
  ])('answers 401 to an anonymous GET %s', async (path) => {
    const { router } = await build(npApiRoutes);
    expect((await router.request(path)).status).toBe(401);
  });

  it('answers 202 with the pending approval when a status change is gated', async () => {
    const { router } = await build(npApiRoutes);
    const response = await router.request('/np/issues/i1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...signedIn },
      body: JSON.stringify({ statusKey: 'done', revision: 1 }),
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      data: {
        issue: { id: 'i1', statusKey: 'in_review' },
        pendingApproval: PENDING,
      },
    });
  });

  it('answers 404 for runs of issues the caller cannot see', async () => {
    const { router, doubles } = await build(npApiRoutes);
    const hidden = await router.request('/np/runs/hidden/events', {
      headers: signedIn,
    });
    expect(hidden.status).toBe(404);
    expect(
      (await router.request('/np/runs/hidden', { headers: signedIn })).status,
    ).toBe(404);
    const visible = await router.request('/np/runs/visible', {
      headers: signedIn,
    });
    expect(visible.status).toBe(200);
    expect(doubles.runQueries.detail).toHaveBeenCalledTimes(1);
  });

  it('computes the webhook URL from the request origin and base path', async () => {
    const { router, doubles } = await build(npApiRoutes);
    const response = await router.request(
      'http://example.test/np/integrations/github',
      { headers: signedIn },
    );
    expect(response.status).toBe(200);
    expect(doubles.connections.view).toHaveBeenCalledWith(
      { type: 'user', id: 'u1' },
      'http://example.test/main/np/webhooks/github',
    );
  });
});

describe('iteration 2 agent routes', () => {
  it('answers 202 when the agent status write waits for approval', async () => {
    const { router } = await build(npAgentRoutes);
    const pending = await router.request(
      '/np/agent/issues/i1/status',
      json({ statusKey: 'done' }, withRunToken),
    );
    expect(pending.status).toBe(202);
    await expect(pending.json()).resolves.toMatchObject({
      data: { pendingApproval: { id: 'ap1' } },
    });
    const applied = await router.request(
      '/np/agent/issues/i1/status',
      json({ statusKey: 'in_review' }, withRunToken),
    );
    expect(applied.status).toBe(200);
  });

  it('links pull requests to the run issue: 201 new, 200 existing, 403 elsewhere', async () => {
    const { router, doubles } = await build(npAgentRoutes);
    const created = await router.request(
      '/np/agent/issues/NP-1/pull-requests',
      json({ url: 'https://github.com/o/r/pull/1' }, withRunToken),
    );
    expect(created.status).toBe(201);
    const again = await router.request(
      '/np/agent/issues/NP-1/pull-requests',
      json({ url: 'https://github.com/o/r/pull/2' }, withRunToken),
    );
    expect(again.status).toBe(200);
    const other = await router.request(
      '/np/agent/issues/i2/pull-requests',
      json({ url: 'https://github.com/o/r/pull/3' }, withRunToken),
    );
    expect(other.status).toBe(403);
    expect(doubles.pullRequests.agentLink).toHaveBeenCalledTimes(2);
    const list = await router.request('/np/agent/issues/NP-1/pull-requests', {
      headers: withRunToken,
    });
    expect(list.status).toBe(200);
    expect(doubles.issueQueries.agentReadable).toHaveBeenCalled();
  });
});
