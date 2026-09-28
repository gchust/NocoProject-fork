// @vitest-environment node
/**
 * GitHub connection and pull request links (iteration-2 contract §C; webhooks in `np-git.test.ts`): the connection (owner/admin,
 * secrets encrypted and never returned), the public webhook (signature, replay, events), the merge flow, the
 * `pr_review` decision, manual links through a fake GitHub client, and agent links without a token. Real
 * PostgreSQL; GitHub itself is never called.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GitHubClient,
  GitHubPullRequestPayload,
} from '../../server/modules/git/github-client.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type {
  IssuePullRequestView,
  IssueV2,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  agentApi,
  buildServices,
  claimOne,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_git_links');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-git-links] skipped: ${skip}`);
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
    getPullRequest: vi.fn(async () => prPayload()),
    getCiState: vi.fn(async () => 'success' as const),
    mergePullRequest: vi.fn(async () => ({ sha: 'merged' })),
    getLatestCiRun: vi.fn(async () => null),
  };
  services = buildServices(db.database, { github }).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
});

describe.skipIf(!db)('GitHub connection (PostgreSQL)', () => {
  it('is managed by owner/admin, stores secrets encrypted and never returns them', async () => {
    await expect(services.gitConnections.view(BOB, 'u')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(services.gitConnections.test(ALICE)).rejects.toMatchObject({
      code: 'GITHUB_NOT_CONFIGURED',
    });
    const view = await services.gitConnections.update(
      ALICE,
      {
        token: TOKEN,
        webhookSecret: SECRET,
        apiBaseUrl: 'https://ghe.example.com/api/v3/',
      },
      'http://x/np/webhooks/github',
    );
    expect(view).toEqual({
      configured: true,
      apiBaseUrl: 'https://ghe.example.com/api/v3',
      tokenSet: true,
      webhookSecretSet: true,
      webhookUrl: 'http://x/np/webhooks/github',
      lastEventAt: null,
    });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    const [row] = await rows(db!, 'git_connections');
    expect(String(row?.token_encrypted)).toMatch(/^v1:/u);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    await expect(services.gitConnections.test(ALICE)).resolves.toEqual({
      ok: true,
      login: 'octo',
      scopes: ['repo'],
    });
    expect(github.getAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        token: TOKEN,
        apiBaseUrl: 'https://ghe.example.com/api/v3',
      }),
    );
    const cleared = await services.gitConnections.update(
      ALICE,
      { token: '' },
      'u',
    );
    expect(cleared).toMatchObject({
      configured: false,
      tokenSet: false,
      webhookSecretSet: true,
    });
  });
});

describe.skipIf(!db)('pull request links (PostgreSQL)', () => {
  it('links by URL through GitHub, refuses without a token or with a bad URL, unlinks and refreshes', async () => {
    const target = await issue();
    await expect(
      services.pullRequests.link(
        ALICE,
        target.id,
        'https://github.com/acme/app/pull/5',
      ),
    ).rejects.toMatchObject({
      code: 'GITHUB_NOT_CONFIGURED',
    });
    await configure();
    await expect(
      services.pullRequests.link(ALICE, target.id, 'https://example.com/x'),
    ).rejects.toMatchObject({
      code: 'INVALID_PR_URL',
    });
    const view = await services.pullRequests.link(
      BOB,
      target.identifier,
      'https://github.com/acme/app/pull/5',
    );
    expect(view).toMatchObject({
      repo: 'acme/app',
      number: 5,
      title: 'Add login',
      ciState: 'success',
      mergeableState: 'clean',
      linkedBy: { type: 'user', id: BOB.id, name: 'Bob' },
      autoCompleteDisabled: false,
    });
    github.getPullRequest.mockResolvedValueOnce(
      prPayload({ title: 'Renamed' }),
    );
    expect(
      (await services.pullRequests.refresh(ALICE, target.id, view.id)).title,
    ).toBe('Renamed');
    await services.pullRequests.unlink(ALICE, target.id, view.id);
    expect(await linked(target.id)).toEqual([]);
    expect(await rows(db!, 'pull_requests')).toHaveLength(1);
    const detail = await services.issueQueries.detail(ALICE, target.id);
    expect(detail.activities.map((item) => item.action)).toEqual(
      expect.arrayContaining(['pr_linked', 'pr_unlinked']),
    );
  });

  it('lets the run agent link a PR without a token (minimal row), 201 then 200', async () => {
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
    const other = await issue('Other');
    const claimed = await claimOne(services, ALICE, fixture);
    const call = agentApi(services, claimed!.token);
    const url = 'https://github.com/acme/app/pull/77';
    const first = await call(
      'POST',
      `/issues/${target.identifier}/pull-requests`,
      { url },
    );
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      number: 77,
      state: 'open',
      linkedBy: { type: 'agent', id: agentId, name: 'Dev' },
    });
    expect(
      (await call('POST', `/issues/${target.id}/pull-requests`, { url }))
        .status,
    ).toBe(200);
    expect(
      (await call('POST', `/issues/${other.id}/pull-requests`, { url })).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/issues/${target.id}/pull-requests`, {
          url: 'nope',
        })
      ).body.code,
    ).toBe('INVALID_PR_URL');
    const list = await call('GET', `/issues/${target.id}/pull-requests`);
    expect(list.body.data).toHaveLength(1);
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(await rows(db!, 'inbox_items', "type = 'pr_review'")).toHaveLength(
      1,
    );
  });
});
