// @vitest-environment node
/**
 * A repository without the NocoProject webhook (NP-122): GitHub never delivers `pull_request closed`, so the REST reads
 * (refresh, merge check, link) run the merge / close flow when they find the stored open PR merged or closed —
 * issue status, `pr_merged` activity, `pr_review` card — exactly once, even when a late webhook races them. Real
 * PostgreSQL; GitHub is the injectable `GitHubClient` fake.
 */
import { createHmac } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GitHubClient,
  GitHubPullRequestPayload,
} from '../../server/modules/git/github-client.ts';
import { createWebhookRoutes } from '../../server/modules/git/webhook.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { IssueV2 } from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  buildServices,
  createAgent,
  claimOne,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_pr_no_webhook');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-pr-no-webhook] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

const SECRET = 'whsec-test';
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

const MERGED = {
  state: 'closed',
  merged: true,
  merged_at: '2026-10-02T00:00:00Z',
} as const;

let services: NpServices;
let github: GitHubClient & Record<string, ReturnType<typeof vi.fn>>;
let deliveries = 0;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  github = {
    getAuthenticatedUser: vi.fn(async () => ({ login: 'octo', scopes: [] })),
    getRepository: vi.fn(async () => ({ fullName: 'acme/app', push: true })),
    getPullRequest: vi.fn(async () => prPayload()),
    getCiState: vi.fn(async () => 'success' as const),
    mergePullRequest: vi.fn(async () => ({ sha: 'squashed1' })),
    getLatestCiRun: vi.fn(async () => null),
  };
  services = buildServices(db.database, { github }).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await services.gitConnections.update(
    ALICE,
    { webhookSecret: SECRET, token: 'ghp_nowebhook_1234567890' },
    'http://test/np/webhooks/github',
  );
});

/** Bob's agent-executed issue in review with the PR linked by its run (the `pr_review` card waits for acceptance). */
async function agentPullRequest(): Promise<{ issue: IssueV2; prId: string }> {
  const fixture = await registerRuntime(services, ALICE);
  const agentId = await createAgent(services, ALICE, fixture.runtimeId, 'Dev');
  const issue = await services.issues.create(ALICE, {
    title: 'Login',
    ownerUserId: BOB.id,
    executor: { type: 'agent', id: agentId },
  });
  const claimed = await claimOne(services, ALICE, fixture);
  const { view } = await services.pullRequests.agentLink(
    { type: 'agent', id: agentId, runId: claimed!.run.id },
    issue,
    URL,
  );
  const current = await services.issueQueries.detail(BOB, issue.id);
  await services.issues.update(BOB, issue.id, {
    statusKey: 'in_review',
    revision: current.issue.revision,
  });
  return { issue, prId: view.id };
}

async function reviewCards(): Promise<Record<string, unknown>[]> {
  return rows(db!, 'inbox_items', "type = 'pr_review'");
}

async function mergedActivities(): Promise<number> {
  return (await rows(db!, 'activities', "action = 'pr_merged'")).length;
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
        'x-github-delivery': `nw-${(deliveries += 1)}`,
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
      body,
    },
  );
  return response.status;
}

const lateMergedWebhook = () =>
  webhook('pull_request', {
    action: 'closed',
    repository: { full_name: 'acme/app' },
    pull_request: prPayload(MERGED),
  });

describe.skipIf(!db)(
  'a PR merged or closed without a webhook (PostgreSQL)',
  () => {
    it('completes the issue when a refresh finds the PR merged', async () => {
      const { issue, prId } = await agentPullRequest();
      // NP-131: in review is not accepted yet, so there is no merge card.
      expect(await reviewCards()).toEqual([]);

      github.getPullRequest.mockImplementation(async () => prPayload(MERGED));
      const view = await services.pullRequests.refresh(BOB, issue.id, prId);
      expect(view.state).toBe('merged');
      const detail = await services.issueQueries.detail(BOB, issue.id);
      expect(detail.issue.statusKey).toBe('done');
      expect(
        detail.activities.find((item) => item.action === 'pr_merged'),
      ).toMatchObject({ details: { statusChangedTo: 'done' } });
      // The merge completed the issue: no card for a PR that is already merged.
      expect(await reviewCards()).toEqual([]);

      // A second refresh and a late delivery find nothing left to do.
      await services.pullRequests.refresh(BOB, issue.id, prId);
      expect(await lateMergedWebhook()).toBe(200);
      expect(await mergedActivities()).toBe(1);
    });

    it('runs the flow from the merge check the confirm dialog opens with', async () => {
      const { issue, prId } = await agentPullRequest();
      github.getPullRequest.mockImplementation(async () => prPayload(MERGED));
      await expect(
        services.pullRequestMerges.preflight(BOB, issue.id, prId),
      ).resolves.toMatchObject({ blocker: 'merged' });
      expect(
        (await services.issueQueries.detail(BOB, issue.id)).issue.statusKey,
      ).toBe('done');
      expect(await reviewCards()).toEqual([]);
      expect(await mergedActivities()).toBe(1);
    });

    it('resolves the card but keeps the status when the PR was closed without merging', async () => {
      const { issue, prId } = await agentPullRequest();
      await services.deliveries.accept(BOB, issue.id, {});
      expect((await reviewCards())[0]?.resolved_at).toBeNull();
      github.getPullRequest.mockImplementation(async () =>
        prPayload({ state: 'closed', closed_at: '2026-10-02T00:00:00Z' }),
      );
      const view = await services.pullRequests.refresh(BOB, issue.id, prId);
      expect(view.state).toBe('closed');
      expect(
        (await services.issueQueries.detail(BOB, issue.id)).issue.statusKey,
      ).toBe('done');
      expect((await reviewCards())[0]?.resolved_at).not.toBeNull();
      expect(await mergedActivities()).toBe(0);
    });

    it('runs the flow once for the issues already linked when the merged PR is linked to another issue', async () => {
      const { issue } = await agentPullRequest();
      const other = await services.issues.create(BOB, { title: 'Follow-up' });
      github.getPullRequest.mockImplementation(async () => prPayload(MERGED));
      await services.pullRequests.link(BOB, other.id, URL);
      expect(
        (await services.issueQueries.detail(BOB, issue.id)).issue.statusKey,
      ).toBe('done');
      // Linking a merged PR does not complete the newly linked issue.
      expect(
        (await services.issueQueries.detail(BOB, other.id)).issue.statusKey,
      ).toBe('todo');
      expect(await rows(db!, 'activities', "action = 'pr_merged'")).toEqual([
        expect.objectContaining({ issue_id: issue.id }),
      ]);
    });

    it('runs the flow once when a refresh and a late webhook race', async () => {
      const { issue, prId } = await agentPullRequest();
      github.getPullRequest.mockImplementation(async () => prPayload(MERGED));
      await Promise.all([
        services.pullRequests.refresh(BOB, issue.id, prId),
        lateMergedWebhook(),
        services.pullRequestMerges.preflight(BOB, issue.id, prId),
      ]);
      expect(await mergedActivities()).toBe(1);
      expect(
        (await services.issueQueries.detail(BOB, issue.id)).issue.statusKey,
      ).toBe('done');
    });
  },
);
