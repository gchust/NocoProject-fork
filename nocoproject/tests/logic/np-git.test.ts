// @vitest-environment node
/**
 * GitHub integration (iteration-2 contract §C; the pure rules are in `np-git-rules.test.ts`): the connection (owner/admin,
 * secrets encrypted and never returned), the public webhook (signature, replay, events), the merge flow, the
 * `pr_review` decision, manual links through a fake GitHub client, and agent links without a token. Real
 * PostgreSQL; GitHub itself is never called.
 */
import { createHmac } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GitHubClient,
  GitHubPullRequestPayload,
} from '../../server/modules/git/github-client.ts';
import { createWebhookRoutes } from '../../server/modules/git/webhook.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type {
  IssuePullRequestView,
  IssueV2,
} from '../../server/modules/shared/protocol.ts';
import { npWebhookRoutes } from '../../server/routes/np-webhooks.ts';
import {
  ALICE,
  BOB,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_git');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-git] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

const SECRET = 'whsec-test';
const TOKEN = 'ghp_testtoken_1234567890';

function prPayload(
  overrides: Partial<GitHubPullRequestPayload> = {},
): GitHubPullRequestPayload {
  return {
    number: 5,
    html_url: 'https://github.com/acme/app/pull/5',
    title: 'Add login',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    head: { ref: 'feature/login', sha: 'abc123' },
    base: { ref: 'main' },
    user: { login: 'dev' },
    additions: 10,
    deletions: 2,
    changed_files: 3,
    mergeable_state: 'clean',
    ...overrides,
  };
}

let services: NpServices;
let github: GitHubClient & Record<string, ReturnType<typeof vi.fn>>;
let deliveries = 0;

function webhook() {
  const router = createWebhookRoutes(services.webhooks);
  return async (
    event: string,
    payload: unknown,
    options: { secret?: string | null; id?: string } = {},
  ) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': options.id ?? `d-${(deliveries += 1)}`,
    };
    if (options.secret !== null)
      headers['x-hub-signature-256'] = `sha256=${createHmac(
        'sha256',
        options.secret ?? SECRET,
      )
        .update(body)
        .digest('hex')}`;
    const response = await router.request('/np/webhooks/github', {
      method: 'POST',
      headers,
      body,
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
}

async function configure(token: string | null = TOKEN): Promise<void> {
  await services.gitConnections.update(
    ALICE,
    { webhookSecret: SECRET, ...(token ? { token } : {}) },
    'http://test/np/webhooks/github',
  );
}

async function issue(title = 'Login'): Promise<IssueV2> {
  return services.issues.create(ALICE, { title });
}

async function linked(issueId: string): Promise<IssuePullRequestView[]> {
  return services.pullRequests.forIssue(issueId);
}

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  github = {
    getAuthenticatedUser: vi.fn(async () => ({
      login: 'octo',
      scopes: ['repo'],
    })),
    getRepository: vi.fn(async () => ({
      fullName: 'acme/app',
      push: true,
      defaultBranch: 'main',
    })),
    getReadAccess: vi.fn(async () => ({
      pullRequests: true,
      statuses: true,
      checks: true,
    })),
    getPullRequest: vi.fn(async () => prPayload()),
    getCiState: vi.fn(async () => 'success' as const),
    mergePullRequest: vi.fn(async () => ({ sha: 'merged' })),
    getLatestCiRun: vi.fn(async () => null),
  };
  services = buildServices(db.database, { github }).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
});

describe.skipIf(!db)('GitHub webhook (PostgreSQL)', () => {
  it('is registered as a public root route', () => {
    expect(npWebhookRoutes.scope).toBe('root');
  });

  it('rejects deliveries without a configured secret, without a signature or with a wrong one', async () => {
    const send = webhook();
    expect((await send('ping', { zen: 'x' })).status).toBe(401);
    await configure();
    const missing = await send('ping', { zen: 'x' }, { secret: null });
    expect(missing).toEqual({
      status: 401,
      body: { code: 'INVALID_SIGNATURE', message: expect.any(String) },
    });
    expect((await send('ping', { zen: 'x' }, { secret: 'wrong' })).status).toBe(
      401,
    );
    expect(await rows(db!, 'webhook_deliveries')).toEqual([]);
    const ok = await send('ping', { zen: 'x' });
    expect(ok).toEqual({
      status: 200,
      body: { data: { ok: true, event: 'ping', ignored: false } },
    });
    expect((await send('issues', { action: 'opened' })).body).toEqual({
      data: { ok: true, event: 'issues', ignored: true },
    });
  });

  it('processes a delivery once and answers duplicates without side effects', async () => {
    await configure();
    const target = await issue();
    const send = webhook();
    const payload = {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      pull_request: prPayload({
        head: {
          ref: `agent/echo/${target.identifier.toLowerCase()}`,
          sha: 's1',
        },
      }),
    };
    expect((await send('pull_request', payload, { id: 'same' })).status).toBe(
      200,
    );
    const again = await send('pull_request', payload, { id: 'same' });
    expect(again).toEqual({ status: 200, body: { data: { duplicate: true } } });
    expect(await rows(db!, 'webhook_deliveries')).toHaveLength(1);
    const links = await linked(target.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      repo: 'acme/app',
      number: 5,
      linkedBy: { type: 'system', id: null },
    });
    const activity = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'pr_linked'",
      [target.id],
    );
    expect(activity).toHaveLength(1);
    expect(
      (await services.gitConnections.view(ALICE, 'u')).lastEventAt,
    ).not.toBeNull();
  });

  it('links every issue a PR names and updates CI by head SHA', async () => {
    await configure();
    const one = await issue('One');
    const two = await issue('Two');
    const send = webhook();
    await send('pull_request', {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      pull_request: prPayload({
        title: `${one.identifier} and ${two.identifier}`,
        head: { ref: 'f', sha: 'sha9' },
      }),
    });
    expect(await linked(one.id)).toHaveLength(1);
    expect(await linked(two.id)).toHaveLength(1);
    await send('check_suite', {
      action: 'completed',
      repository: { full_name: 'acme/app' },
      check_suite: {
        head_sha: 'sha9',
        status: 'completed',
        conclusion: 'failure',
      },
    });
    expect((await linked(one.id))[0]?.ciState).toBe('failure');
    // A suite without check runs is no CI (NP-195): it changes nothing.
    await send('check_suite', {
      action: 'completed',
      repository: { full_name: 'acme/app' },
      check_suite: {
        head_sha: 'sha9',
        status: 'completed',
        conclusion: 'success',
        latest_check_runs_count: 0,
      },
    });
    expect((await linked(one.id))[0]?.ciState).toBe('failure');
    await send('status', {
      repository: { full_name: 'acme/app' },
      sha: 'sha9',
      state: 'success',
    });
    expect((await linked(two.id))[0]?.ciState).toBe('success');
  });

  it('completes the issue when every counted PR is merged, and notifies subscribers', async () => {
    await configure();
    const target = await issue();
    await services.issues.update(ALICE, target.id, {
      statusKey: 'in_review',
      revision: target.revision,
    });
    await services.inbox.subscribe(BOB, target.id);
    const send = webhook();
    const pr = (
      number: number,
      extra: Partial<GitHubPullRequestPayload> = {},
    ) => ({
      repository: { full_name: 'acme/app' },
      pull_request: prPayload({
        number,
        title: `${target.identifier} part ${number}`,
        ...extra,
      }),
    });
    await send('pull_request', { action: 'opened', ...pr(1) });
    await send('pull_request', { action: 'opened', ...pr(2) });
    await send('pull_request', {
      action: 'closed',
      ...pr(1, {
        state: 'closed',
        merged: true,
        merged_at: '2026-09-27T00:00:00Z',
      }),
    });
    let detail = await services.issueQueries.detail(ALICE, target.id);
    expect(detail.issue.statusKey).toBe('in_review');
    expect(
      detail.activities.filter((item) => item.action === 'pr_merged'),
    ).toHaveLength(1);
    const second = detail.pullRequests.find((item) => item.number === 2)!;
    await services.pullRequests.setAutoComplete(
      ALICE,
      target.id,
      second.id,
      true,
    );
    await send('pull_request', {
      action: 'closed',
      ...pr(2, {
        state: 'closed',
        merged: true,
        merged_at: '2026-09-27T01:00:00Z',
      }),
    });
    detail = await services.issueQueries.detail(ALICE, target.id);
    expect(detail.issue.statusKey).toBe('done');
    const merged = detail.activities.filter(
      (item) => item.action === 'pr_merged',
    );
    expect(merged.at(-1)?.details).toMatchObject({
      repo: 'acme/app',
      number: 2,
      statusChangedTo: 'done',
    });
    const statusChange = detail.activities
      .filter((item) => item.action === 'status_changed')
      .at(-1);
    expect(statusChange).toMatchObject({ actorType: 'system' });
    const notices = await rows(
      db!,
      'inbox_items',
      "type = 'pr_merged' AND user_id = ?",
      [BOB.id],
    );
    expect(notices).toHaveLength(1);
  });

  it('leaves the status alone with prMergedStatus none, and on terminal issues only records activity', async () => {
    await configure();
    await services.workspaceSettings.update(ALICE, { prMergedStatus: 'none' });
    const open = await issue('Open');
    const send = webhook();
    const merged = {
      action: 'closed',
      repository: { full_name: 'acme/app' },
      pull_request: prPayload({
        title: open.identifier,
        state: 'closed',
        merged: true,
        merged_at: '2026-09-27T00:00:00Z',
      }),
    };
    await send('pull_request', merged);
    expect(
      (await services.issueQueries.detail(ALICE, open.id)).issue.statusKey,
    ).toBe('todo');
    await services.workspaceSettings.update(ALICE, { prMergedStatus: 'done' });
    const closed = await issue('Closed');
    await services.issues.update(ALICE, closed.id, {
      statusKey: 'cancelled',
      revision: closed.revision,
    });
    await send('pull_request', {
      ...merged,
      pull_request: prPayload({
        number: 8,
        title: closed.identifier,
        state: 'closed',
        merged: true,
        merged_at: '2026-09-27T00:00:00Z',
      }),
    });
    const detail = await services.issueQueries.detail(ALICE, closed.id);
    expect(detail.issue.statusKey).toBe('cancelled');
    expect(detail.activities.some((item) => item.action === 'pr_merged')).toBe(
      true,
    );
  });

  it('asks the owner to review a ready PR on an agent-executed issue and resolves it when merged', async () => {
    await configure();
    const fixture = await registerRuntime(services, ALICE);
    const agentId = await createAgent(
      services,
      ALICE,
      fixture.runtimeId,
      'Dev',
    );
    const target = await services.issues.create(ALICE, {
      title: 'Agent',
      executor: { type: 'agent', id: agentId },
    });
    const send = webhook();
    const base = { repository: { full_name: 'acme/app' } };
    await send('pull_request', {
      ...base,
      action: 'opened',
      pull_request: prPayload({ title: target.identifier, draft: true }),
    });
    expect(await rows(db!, 'inbox_items', "type = 'pr_review'")).toEqual([]);
    await send('pull_request', {
      ...base,
      action: 'ready_for_review',
      pull_request: prPayload({ title: target.identifier }),
    });
    // NP-128 / NP-131: held until the delivery is accepted; in_review alone does not deliver it.
    for (const statusKey of ['in_review', 'done']) {
      expect(await rows(db!, 'inbox_items', "type = 'pr_review'")).toEqual([]);
      const current = await services.issueQueries.detail(ALICE, target.id);
      await services.issues.update(ALICE, target.id, {
        statusKey,
        revision: current.issue.revision,
      });
    }
    const cards = await rows(db!, 'inbox_items', "type = 'pr_review'");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      user_id: ALICE.id,
      kind: 'decision',
      dedupe_key: `user:${ALICE.id}:pr_review:${target.id}`,
    });
    await send('pull_request', {
      ...base,
      action: 'closed',
      pull_request: prPayload({
        title: target.identifier,
        state: 'closed',
        merged: true,
        merged_at: '2026-09-27T00:00:00Z',
      }),
    });
    expect(
      (await rows(db!, 'inbox_items', "type = 'pr_review'"))[0]?.resolved_at,
    ).not.toBeNull();
  });
});
