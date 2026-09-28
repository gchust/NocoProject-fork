// @vitest-environment node
/**
 * Merging a linked pull request from NocoProject (NP-85, docs/phase1/protocol-iteration-4.md): who may merge, when a
 * PR may be merged (always read fresh from GitHub), the squash call and how GitHub failures map, the activity, the
 * webhook still completing the issue, the `pr_review` merge action and the CI run links. Real PostgreSQL; GitHub is
 * the injectable `GitHubClient` fake.
 */
import { createHmac } from 'node:crypto';

import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitHubApiError,
  type GitHubClient,
  type GitHubPullRequestPayload,
} from '../../server/modules/git/github-client.ts';
import { createIssuePullRequestRoutes } from '../../server/modules/git/git.routes.ts';
import { createWebhookRoutes } from '../../server/modules/git/webhook.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import {
  guarded,
  npRouter,
  rejectRunTokens,
} from '../../server/modules/shared/http.ts';
import type {
  IssuePullRequestViewV4,
  IssueV2,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_pr_merge');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-pr-merge] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

const DAN: Actor = { type: 'user', id: 'u-dan' };
const ERIN: Actor = { type: 'user', id: 'u-erin' };
const SECRET = 'whsec-test';
const TOKEN = 'ghp_mergetoken_1234567890';
const URL = 'https://github.com/acme/app/pull/5';

function prPayload(
  overrides: Partial<GitHubPullRequestPayload> = {},
): GitHubPullRequestPayload {
  return {
    number: 5,
    html_url: URL,
    title: 'Add login',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    head: { ref: 'feature/login', sha: 'head1' },
    base: { ref: 'main' },
    user: { login: 'dev' },
    additions: 10,
    deletions: 2,
    changed_files: 3,
    mergeable_state: 'clean',
    mergeable: true,
    ...overrides,
  };
}

let services: NpServices;
let github: GitHubClient & Record<string, ReturnType<typeof vi.fn>>;
let deliveries = 0;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  github = {
    getAuthenticatedUser: vi.fn(async () => ({ login: 'octo', scopes: [] })),
    getPullRequest: vi.fn(async () => prPayload()),
    getCiState: vi.fn(async () => 'success' as const),
    mergePullRequest: vi.fn(async () => ({ sha: 'squashed1' })),
    getLatestCiRun: vi.fn(async () => ({
      runUrl: 'https://github.com/acme/app/actions/runs/77',
      screenshotsUrl: 'https://github.com/acme/app/actions/runs/77/artifacts/9',
    })),
  };
  services = buildServices(db.database, { github }).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  await setRole(db, DAN, 'member');
  await setRole(db, ERIN, 'admin');
  await services.gitConnections.update(
    ALICE,
    { webhookSecret: SECRET, token: TOKEN },
    'http://test/np/webhooks/github',
  );
});

/** Bob's issue in a project Carol leads, with the PR linked. */
async function fixture(): Promise<{
  issue: IssueV2;
  pr: IssuePullRequestViewV4;
}> {
  const project = await services.projects.create(ALICE, {
    name: 'App',
    leadUserId: CAROL.id,
  });
  const issue = await services.issues.create(BOB, {
    title: 'Login',
    projectId: project.id,
  });
  const pr = (await services.pullRequests.link(
    BOB,
    issue.id,
    URL,
  )) as IssuePullRequestViewV4;
  return { issue, pr };
}

function api(as: Actor | null) {
  const signIn = async (
    context: { set: (key: 'auth', value: never) => void },
    next: () => Promise<void>,
  ) => {
    if (as)
      context.set('auth', {
        user: { id: as.id, name: as.id, email: `${as.id}@x` },
        session: {},
      } as never);
    await next();
  };
  const root = npRouter<AuthEnv>();
  root.route(
    '/np/issues',
    guarded(
      [rejectRunTokens(), signIn],
      createIssuePullRequestRoutes(
        services.pullRequests,
        services.pullRequestMerges,
      ),
    ),
  );
  return async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await root.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
}

async function webhook(event: string, payload: unknown): Promise<number> {
  const body = JSON.stringify(payload);
  const response = await createWebhookRoutes(services.webhooks).request(
    '/np/webhooks/github',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': `m-${(deliveries += 1)}`,
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
      body,
    },
  );
  return response.status;
}

const merged = () =>
  webhook('pull_request', {
    action: 'closed',
    repository: { full_name: 'acme/app' },
    pull_request: prPayload({
      state: 'closed',
      merged: true,
      merged_at: '2026-10-02T00:00:00Z',
    }),
  });

describe.skipIf(!db)('merging a pull request (PostgreSQL)', () => {
  it('lets the issue owner, the project lead and owner/admin merge; others 403, hidden issues 404', async () => {
    const { issue, pr } = await fixture();
    for (const actor of [BOB, CAROL, ALICE, ERIN])
      await expect(
        services.pullRequestMerges.preflight(actor, issue.id, pr.id),
      ).resolves.toMatchObject({ blocker: null, headSha: 'head1' });
    await expect(
      services.pullRequestMerges.preflight(DAN, issue.id, pr.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.pullRequestMerges.merge(DAN, issue.id, pr.id, 'head1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.pullRequestMerges.merge(
        { type: 'agent', id: 'a-1' },
        issue.id,
        pr.id,
        'head1',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(github.mergePullRequest).not.toHaveBeenCalled();

    // A lead through projectMembers counts too.
    const project = await services.projects.create(ALICE, {
      name: 'Team',
      visibility: 'members',
    });
    await services.projects.addMember(ALICE, project.id, {
      userId: CAROL.id!,
      role: 'lead',
    });
    const hidden = await services.issues.create(ALICE, {
      title: 'Team work',
      projectId: project.id,
    });
    const teamPr = await services.pullRequests.link(ALICE, hidden.id, URL);
    await expect(
      services.pullRequestMerges.preflight(CAROL, hidden.id, teamPr.id),
    ).resolves.toMatchObject({ blocker: null });
    await expect(
      services.pullRequestMerges.preflight(BOB, hidden.id, teamPr.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const own = await services.issueQueries.detail(BOB, issue.id);
    expect(own.pullRequests[0]).toMatchObject({ viewerCanMerge: true });
    const other = await services.issueQueries.detail(DAN, issue.id);
    expect(other.pullRequests[0]).toMatchObject({ viewerCanMerge: false });
    expect(
      (await services.pullRequests.list(DAN, issue.id))[0]?.viewerCanMerge,
    ).toBe(false);
  });

  it('guards the routes: 401 signed out, 403 run token or non-merger, 404 hidden', async () => {
    const { issue, pr } = await fixture();
    const path = `/np/issues/${issue.id}/pull-requests/${pr.id}/merge`;
    expect((await api(null)('GET', path)).status).toBe(401);
    const runToken = await api(BOB)(
      'POST',
      path,
      { expectedHeadSha: 'head1' },
      {
        authorization: 'Bearer npr_leaked',
      },
    );
    expect(runToken).toMatchObject({
      status: 403,
      body: { code: 'RUN_TOKEN_FORBIDDEN' },
    });
    expect(
      (await api(DAN)('POST', path, { expectedHeadSha: 'head1' })).body,
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await api(BOB)('GET', `/np/issues/NP-999/pull-requests/${pr.id}/merge`))
        .status,
    ).toBe(404);
    const preflight = await api(BOB)('GET', path);
    expect(preflight).toEqual({
      status: 200,
      body: {
        data: {
          blocker: null,
          method: 'squash',
          headSha: 'head1',
          baseRef: 'main',
          commitTitle: 'Add login (#5)',
          statusAfter: {
            statusKey: 'done',
            statusName: 'Done',
            keepReason: null,
          },
        },
      },
    });
    expect(await api(BOB)('POST', path, { expectedHeadSha: 'head1' })).toEqual({
      status: 200,
      body: { data: { merged: true, sha: 'squashed1' } },
    });
    expect((await api(BOB)('POST', path, {})).body).toMatchObject({
      code: 'INVALID_EXPECTED_HEAD',
    });
  });

  it.each([
    ['closed', { state: 'closed' }, 'success'],
    [
      'merged',
      { state: 'closed', merged: true, merged_at: '2026-10-01T00:00:00Z' },
      'success',
    ],
    ['draft', { draft: true }, 'success'],
    ['conflicts', { mergeable: false, mergeable_state: 'dirty' }, 'success'],
    ['conflicts', { mergeable_state: 'dirty' }, 'success'],
    ['computing', { mergeable: null, mergeable_state: 'unknown' }, 'success'],
    ['ciPending', {}, 'pending'],
    ['ciFailed', {}, 'failure'],
    ['ciMissing', {}, null],
  ] as const)(
    'refuses %s (fresh from GitHub, even when the stored snapshot looked fine)',
    async (blocker, payload, ci) => {
      const { issue, pr } = await fixture();
      github.getPullRequest.mockImplementation(async () =>
        prPayload(payload as Partial<GitHubPullRequestPayload>),
      );
      github.getCiState.mockImplementation(async () => ci);
      await expect(
        services.pullRequestMerges.preflight(BOB, issue.id, pr.id),
      ).resolves.toMatchObject({ blocker });
      await expect(
        services.pullRequestMerges.merge(BOB, issue.id, pr.id, 'head1'),
      ).rejects.toMatchObject({
        code: 'PR_NOT_MERGEABLE',
        details: { blocker },
      });
      expect(github.mergePullRequest).not.toHaveBeenCalled();
    },
  );

  it('reports a missing token as notConfigured', async () => {
    const { issue, pr } = await fixture();
    await services.gitConnections.update(ALICE, { token: '' }, 'u');
    await expect(
      services.pullRequestMerges.preflight(BOB, issue.id, pr.id),
    ).resolves.toMatchObject({ blocker: 'notConfigured' });
    await expect(
      services.pullRequestMerges.merge(BOB, issue.id, pr.id, 'head1'),
    ).rejects.toMatchObject({ details: { blocker: 'notConfigured' } });
  });

  it('refuses a stale confirmation: new commits since the preflight, or GitHub 409', async () => {
    const { issue, pr } = await fixture();
    github.getPullRequest.mockImplementation(async () =>
      prPayload({ head: { ref: 'feature/login', sha: 'head2' } }),
    );
    await expect(
      services.pullRequestMerges.merge(BOB, issue.id, pr.id, 'head1'),
    ).rejects.toMatchObject({ code: 'PR_CHANGED' });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    github.mergePullRequest.mockRejectedValueOnce(new GitHubApiError(409, 'x'));
    await expect(
      services.pullRequestMerges.merge(BOB, issue.id, pr.id, 'head2'),
    ).rejects.toMatchObject({ code: 'PR_CHANGED' });
  });

  it.each([
    [403, 'GITHUB_MERGE_FORBIDDEN'],
    [404, 'GITHUB_MERGE_FORBIDDEN'],
    [401, 'GITHUB_AUTH_FAILED'],
    [405, 'PR_NOT_MERGEABLE'],
    [500, 'GITHUB_REQUEST_FAILED'],
    [0, 'GITHUB_REQUEST_FAILED'],
  ])(
    'maps GitHub %s on merge to %s without leaking the token',
    async (status, code) => {
      const { issue, pr } = await fixture();
      github.mergePullRequest.mockRejectedValue(
        new GitHubApiError(status, `GitHub answered ${status}: ${TOKEN}`),
      );
      const error = await services.pullRequestMerges
        .merge(BOB, issue.id, pr.id, 'head1')
        .catch((caught: unknown) => caught as Record<string, unknown>);
      expect(error).toMatchObject({ code });
      if (status === 405)
        expect(error).toMatchObject({ details: { blocker: 'protected' } });
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect(String((error as { message?: string }).message)).not.toContain(
        TOKEN,
      );
      const response = await api(BOB)(
        'POST',
        `/np/issues/${issue.id}/pull-requests/${pr.id}/merge`,
        { expectedHeadSha: 'head1' },
      );
      expect(JSON.stringify(response.body)).not.toContain(TOKEN);
      expect(
        await rows(db!, 'activities', "action = 'pr_merge_requested'"),
      ).toEqual([]);
    },
  );

  it('squash-merges, records the request and leaves the status to the webhook', async () => {
    const { issue, pr } = await fixture();
    await services.issues.update(BOB, issue.id, {
      statusKey: 'in_review',
      revision: issue.revision,
    });
    await expect(
      services.pullRequestMerges.merge(BOB, issue.identifier, pr.id, 'head1'),
    ).resolves.toEqual({ merged: true, sha: 'squashed1' });
    expect(github.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ token: TOKEN }),
      'acme/app',
      5,
      { sha: 'head1', commitTitle: 'Add login (#5)' },
    );
    let detail = await services.issueQueries.detail(BOB, issue.id);
    expect(detail.issue.statusKey).toBe('in_review');
    expect(detail.pullRequests[0]?.state).toBe('open');
    expect(
      detail.activities.find((item) => item.action === 'pr_merge_requested'),
    ).toMatchObject({
      actorType: 'user',
      details: {
        pullRequestId: pr.id,
        repo: 'acme/app',
        number: 5,
        url: URL,
        sha: 'head1',
        method: 'squash',
      },
    });

    // A refresh that already sees the merge keeps the row open, so the webhook still sees the transition.
    github.getPullRequest.mockImplementation(async () =>
      prPayload({
        state: 'closed',
        merged: true,
        merged_at: '2026-10-02T00:00:00Z',
      }),
    );
    await services.pullRequests.refresh(BOB, issue.id, pr.id);
    await expect(
      services.pullRequestMerges.preflight(BOB, issue.id, pr.id),
    ).resolves.toMatchObject({ blocker: 'merged' });
    expect((await services.pullRequests.list(BOB, issue.id))[0]?.state).toBe(
      'open',
    );
    expect(await merged()).toBe(200);
    detail = await services.issueQueries.detail(BOB, issue.id);
    expect(detail.issue.statusKey).toBe('done');
    expect(detail.pullRequests[0]?.state).toBe('merged');
  });

  it('tells what merging does to the issue', async () => {
    const { issue, pr } = await fixture();
    const after = async () =>
      (await services.pullRequestMerges.preflight(BOB, issue.id, pr.id))
        .statusAfter;
    expect(await after()).toEqual({
      statusKey: 'done',
      statusName: 'Done',
      keepReason: null,
    });
    github.getPullRequest.mockImplementation(async () =>
      prPayload({ number: 6, html_url: 'https://github.com/acme/app/pull/6' }),
    );
    await services.pullRequests.link(
      BOB,
      issue.id,
      'https://github.com/acme/app/pull/6',
    );
    github.getPullRequest.mockImplementation(async () => prPayload());
    expect(await after()).toMatchObject({ keepReason: 'otherPrs' });
    await services.pullRequests.setAutoComplete(BOB, issue.id, pr.id, true);
    expect(await after()).toMatchObject({ keepReason: 'optedOut' });
    await services.workspaceSettings.update(ALICE, { prMergedStatus: 'none' });
    expect(await after()).toMatchObject({ keepReason: 'setting' });
    const current = await services.issueQueries.detail(BOB, issue.id);
    await services.issues.update(BOB, issue.id, {
      statusKey: 'cancelled',
      revision: current.issue.revision,
    });
    expect(await after()).toMatchObject({ keepReason: 'terminal' });
  });

  it('stores the CI run and screenshots links, backfills them after check suites and drops them when the head moves', async () => {
    const { issue, pr } = await fixture();
    expect(pr).toMatchObject({
      ciRunUrl: 'https://github.com/acme/app/actions/runs/77',
      screenshotsUrl: 'https://github.com/acme/app/actions/runs/77/artifacts/9',
    });
    await webhook('pull_request', {
      action: 'synchronize',
      repository: { full_name: 'acme/app' },
      pull_request: prPayload({ head: { ref: 'feature/login', sha: 'head3' } }),
    });
    expect((await services.pullRequests.list(BOB, issue.id))[0]).toMatchObject({
      headSha: 'head3',
      ciRunUrl: null,
      screenshotsUrl: null,
    });
    github.getLatestCiRun.mockImplementation(async () => ({
      runUrl: 'https://github.com/acme/app/actions/runs/78',
      screenshotsUrl: null,
    }));
    await webhook('check_suite', {
      action: 'completed',
      repository: { full_name: 'acme/app' },
      check_suite: {
        head_sha: 'head3',
        status: 'completed',
        conclusion: 'success',
      },
    });
    expect(github.getLatestCiRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: TOKEN }),
      'acme/app',
      'head3',
    );
    expect((await services.pullRequests.list(BOB, issue.id))[0]).toMatchObject({
      ciState: 'success',
      ciRunUrl: 'https://github.com/acme/app/actions/runs/78',
      screenshotsUrl: null,
    });
    // A failing lookup changes nothing and does not fail the delivery.
    github.getLatestCiRun.mockRejectedValue(new GitHubApiError(500, 'x'));
    expect(
      await webhook('check_suite', {
        action: 'completed',
        repository: { full_name: 'acme/app' },
        check_suite: {
          head_sha: 'head3',
          status: 'completed',
          conclusion: 'failure',
        },
      }),
    ).toBe(200);
    await services.pullRequests.refresh(BOB, issue.id, pr.id);
    expect(
      (await services.pullRequests.list(BOB, issue.id))[0]?.ciRunUrl,
    ).toBeNull();
  });

  it('offers merge on an open pr_review card to a recipient who may merge', async () => {
    const { runtimeId } = await registerRuntime(services, ALICE);
    const agentId = await createAgent(services, ALICE, runtimeId, 'Dev');
    const issue = await services.issues.create(ALICE, {
      title: 'Agent work',
      ownerUserId: BOB.id,
      executor: { type: 'agent', id: agentId },
    });
    github.getCiState.mockImplementation(async () => 'pending');
    github.getPullRequest.mockImplementation(async () =>
      prPayload({ title: `${issue.identifier}: login` }),
    );
    await webhook('pull_request', {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      pull_request: prPayload({ title: `${issue.identifier}: login` }),
    });
    const [pr] = await services.pullRequests.list(BOB, issue.id);
    await services.pullRequests.refresh(BOB, issue.id, pr!.id);
    const card = async (user: Actor) =>
      (await services.inbox.list(user, {})).data.find(
        (item) => item.type === 'pr_review',
      );
    const actions = (await card(BOB))?.payload.actions as Record<
      string,
      unknown
    >[];
    expect(actions.map((action) => action.key)).toEqual([
      'merge',
      'openPr',
      'open',
    ]);
    expect(actions[0]).toMatchObject({
      kind: 'primary',
      method: 'POST',
      path: `/np/issues/${encodeURIComponent(issue.id)}/pull-requests/${pr!.id}/merge`,
      confirm: 'prMerge',
      pullRequestId: pr!.id,
      disabledReason: 'ciPending',
    });
    expect(actions[1]).toMatchObject({ key: 'openPr', kind: 'secondary' });

    // Once Bob no longer owns the issue, his card only links out.
    const current = await services.issueQueries.detail(BOB, issue.id);
    await services.issues.update(BOB, issue.id, {
      ownerUserId: CAROL.id,
      revision: current.issue.revision,
    });
    const after = (await card(BOB))?.payload.actions as Record<
      string,
      unknown
    >[];
    expect(after.map((action) => action.key)).toEqual(['openPr', 'open']);
    expect(after[0]).toMatchObject({ kind: 'primary' });

    await merged();
    const resolved = (
      await services.inbox.list(BOB, { resolved: 'true' })
    ).data.find((item) => item.type === 'pr_review');
    expect(
      (resolved?.payload.actions as Record<string, unknown>[]).map(
        (action) => action.key,
      ),
    ).not.toContain('merge');
  });
});
