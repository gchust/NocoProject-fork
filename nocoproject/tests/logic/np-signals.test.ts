// @vitest-environment node
/**
 * Signals (protocol.phase2-signals.ts): a linked pull request's failed checks or merge conflicts wake the issue's
 * executor agent — only when a person turned the rule on, once per occurrence, at most `maxConsecutive` times in a row
 * before the owner takes over, and never for an issue a person executes. Conflicts are found by the merge-check queue a
 * push to the base branch fills. Real PostgreSQL; GitHub is the injectable `GitHubClient` fake.
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
  claimOne,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_signals');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-signals] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

const SECRET = 'whsec-signals';
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
    getCiState: vi.fn(async () => 'pending' as const),
    mergePullRequest: vi.fn(async () => ({ sha: 'squashed1' })),
    getLatestCiRun: vi.fn(async () => null),
  };
  services = buildServices(db.database, { github }).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await services.gitConnections.update(
    ALICE,
    { webhookSecret: SECRET, token: 'ghp_signals_1234567890' },
    'http://test/np/webhooks/github',
  );
});

type Fixture = Awaited<ReturnType<typeof registerRuntime>>;

/** Alice owns an issue her agent Dev executes; its first run linked PR #5 and finished; the issue is in review. */
async function agentPullRequest(): Promise<{
  issue: IssueV2;
  agentId: string;
  fixture: Fixture;
}> {
  const fixture = await registerRuntime(services, ALICE);
  const agentId = await createAgent(services, ALICE, fixture.runtimeId, 'Dev');
  const issue = await services.issues.create(ALICE, {
    title: 'Login',
    executor: { type: 'agent', id: agentId },
  });
  const claimed = await claimOne(services, ALICE, fixture);
  await services.pullRequests.agentLink(
    { type: 'agent', id: agentId, runId: claimed!.run.id },
    issue,
    URL,
  );
  await services.runs.complete(claimed!.run.id, { workDir: '/tmp/w' });
  const current = await services.issueQueries.detail(ALICE, issue.id);
  await services.issues.update(ALICE, issue.id, {
    statusKey: 'in_review',
    revision: current.issue.revision,
  });
  return { issue, agentId, fixture };
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
        'x-github-delivery': `sig-${(deliveries += 1)}`,
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
      body,
    },
  );
  return response.status;
}

const checkSuite = (sha: string, conclusion: 'failure' | 'success') =>
  webhook('check_suite', {
    action: 'completed',
    repository: { full_name: 'acme/app' },
    check_suite: { head_sha: sha, status: 'completed', conclusion },
  });

/** A new head on PR #5 (`synchronize`). */
const pushHead = (sha: string) =>
  webhook('pull_request', {
    action: 'synchronize',
    repository: { full_name: 'acme/app' },
    pull_request: prPayload({
      head: { ref: 'feature/login', sha },
      mergeable_state: 'unknown',
      mergeable: null,
    }),
  });

async function enableRules(rules: Record<string, unknown>): Promise<void> {
  await services.workspaceSettings.update(ALICE, { signalRules: rules });
}

function parsed(row: Record<string, unknown>, field: string) {
  const value = row[field];
  return {
    ...row,
    [field]: typeof value === 'string' ? JSON.parse(value) : value,
  };
}

async function signalTriggers(): Promise<Record<string, unknown>[]> {
  return (await rows(db!, 'run_triggers', "type = 'signal'")).map((row) =>
    parsed(row, 'payload'),
  );
}

async function signalActivities(action: string) {
  return (await rows(db!, 'activities', `action = '${action}'`)).map((row) =>
    parsed(row, 'details'),
  );
}

describe.skipIf(!db)('signal rules (settings)', () => {
  it('are off by default, list the known kinds and validate what is stored', async () => {
    const view = await services.workspaceSettings.view(BOB);
    expect(view.signalRules).toEqual({});
    expect(view.signalKinds.map((info) => info.kind)).toEqual([
      'github.ciFailed',
      'github.conflict',
    ]);
    expect(view.signalKinds[0]).toMatchObject({
      source: 'github',
      defaultInstruction: expect.stringContaining('{{headRef}}'),
    });

    await expect(
      enableRules({ 'jira.blocked': { enabled: true } }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNAL_RULES' });
    await expect(
      enableRules({ 'github.ciFailed': { enabled: true, maxConsecutive: 0 } }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNAL_RULES' });
    await expect(
      services.workspaceSettings.update(BOB, {
        signalRules: { 'github.ciFailed': { enabled: true } },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await enableRules({
      'github.ciFailed': { enabled: true, instruction: '  ' },
    });
    await enableRules({
      'github.conflict': { enabled: false, maxConsecutive: 5 },
    });
    expect((await services.workspaceSettings.view(BOB)).signalRules).toEqual({
      'github.ciFailed': {
        enabled: true,
        instruction: null,
        maxConsecutive: 3,
      },
      'github.conflict': {
        enabled: false,
        instruction: null,
        maxConsecutive: 5,
      },
    });
  });
});

describe.skipIf(!db)('CI failure signals (PostgreSQL)', () => {
  it('does nothing while no rule is on', async () => {
    const { issue } = await agentPullRequest();
    expect(await checkSuite('head1', 'failure')).toBe(200);
    expect(await signalTriggers()).toEqual([]);
    expect(await signalActivities('signal_received')).toEqual([]);
    const [pr] = await services.pullRequests.forIssue(issue.id);
    expect(pr?.ciState).toBe('failure');
  });

  it('wakes the executor once per failing head, on behalf of the owner, with the rendered instruction', async () => {
    const { issue, agentId, fixture } = await agentPullRequest();
    await enableRules({ 'github.ciFailed': { enabled: true } });

    await checkSuite('head1', 'failure');
    // A second suite (or a redelivery) failing the same head is the same occurrence.
    await checkSuite('head1', 'failure');
    const [trigger] = await signalTriggers();
    expect(await signalTriggers()).toHaveLength(1);
    const run = (
      await rows(db!, 'runs', `id = '${String(trigger?.run_id)}'`)
    )[0];
    expect(run).toMatchObject({
      agent_id: agentId,
      subject_id: issue.id,
      actor_user_id: ALICE.id,
      owner_user_id: ALICE.id,
      thread_scope: null,
    });
    const payload = trigger?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      source: 'github',
      kind: 'github.ciFailed',
      key: 'acme/app#5@head1',
      title: 'Checks failed on acme/app#5',
      url: URL,
    });
    expect(payload.instruction).toContain(
      'fix it on the same branch `feature/login`',
    );
    expect(await signalActivities('signal_received')).toEqual([
      expect.objectContaining({
        issue_id: issue.id,
        actor_type: 'system',
        details: expect.objectContaining({
          kind: 'github.ciFailed',
          runId: trigger?.run_id,
        }),
      }),
    ]);

    // The daemon gets the signal in the claim payload.
    const claimed = await claimOne(services, ALICE, fixture);
    expect(claimed?.run.id).toBe(trigger?.run_id);
    expect(
      (claimed?.triggers as { type: string; signal?: unknown }[]).find(
        (item) => item.type === 'signal',
      )?.signal,
    ).toMatchObject({
      kind: 'github.ciFailed',
      title: 'Checks failed on acme/app#5',
      instruction: expect.stringContaining('feature/login'),
    });
  });

  it('uses the rule’s own instruction with the placeholders filled', async () => {
    await agentPullRequest();
    await enableRules({
      'github.ciFailed': {
        enabled: true,
        instruction: 'Repair {{repo}}#{{number}} on {{headRef}} ({{unknown}}).',
      },
    });
    await checkSuite('head1', 'failure');
    const [trigger] = await signalTriggers();
    expect((trigger?.payload as { instruction: string }).instruction).toBe(
      'Repair acme/app#5 on feature/login ({{unknown}}).',
    );
  });

  it('stops after the limit, tells the owner once, and starts over when the checks pass', async () => {
    const { issue } = await agentPullRequest();
    await enableRules({
      'github.ciFailed': { enabled: true, maxConsecutive: 2 },
    });

    await checkSuite('head1', 'failure');
    await pushHead('head2');
    await checkSuite('head2', 'failure');
    expect(await signalActivities('signal_received')).toHaveLength(2);

    await pushHead('head3');
    await checkSuite('head3', 'failure');
    await pushHead('head4');
    await checkSuite('head4', 'failure');
    expect(await signalActivities('signal_received')).toHaveLength(2);
    expect(await signalActivities('signal_suppressed')).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ limit: 2, key: 'acme/app#5@head3' }),
      }),
    ]);
    expect(
      await rows(db!, 'inbox_items', "type = 'signal_suppressed'"),
    ).toEqual([
      expect.objectContaining({ user_id: ALICE.id, issue_id: issue.id }),
    ]);

    // The checks pass: the streak ends, and the next failure wakes the agent again.
    await pushHead('head5');
    await checkSuite('head5', 'success');
    expect(await signalActivities('signal_resolved')).toHaveLength(1);
    await checkSuite('head5', 'success');
    expect(await signalActivities('signal_resolved')).toHaveLength(1);
    await pushHead('head6');
    await checkSuite('head6', 'failure');
    expect(await signalActivities('signal_received')).toHaveLength(3);
  });

  it('leaves issues a person executes, and done issues, alone', async () => {
    const human = await services.issues.create(BOB, { title: 'By hand' });
    const { issue } = await agentPullRequest();
    await services.pullRequests.link(BOB, human.id, URL);
    await enableRules({ 'github.ciFailed': { enabled: true } });

    await checkSuite('head1', 'failure');
    expect(await signalActivities('signal_received')).toEqual([
      expect.objectContaining({ issue_id: issue.id }),
    ]);

    const current = await services.issueQueries.detail(ALICE, issue.id);
    await services.issues.update(ALICE, issue.id, {
      statusKey: 'done',
      revision: current.issue.revision,
    });
    await pushHead('head2');
    await checkSuite('head2', 'failure');
    expect(await signalActivities('signal_received')).toHaveLength(1);
  });
});

describe.skipIf(!db)('signal authority (PostgreSQL)', () => {
  it('starts no run for an owner who may not invoke the executor agent', async () => {
    const fixture = await registerRuntime(services, ALICE);
    const agentId = await createAgent(
      services,
      ALICE,
      fixture.runtimeId,
      'Dev',
    );
    const issue = await services.issues.create(ALICE, {
      title: 'Login',
      ownerUserId: BOB.id,
      executor: { type: 'agent', id: agentId },
    });
    await services.pullRequests.link(ALICE, issue.id, URL);
    await enableRules({ 'github.ciFailed': { enabled: true } });
    await checkSuite('head1', 'failure');
    expect(await signalTriggers()).toEqual([]);
    expect(await signalActivities('signal_received')).toEqual([]);
  });
});

describe.skipIf(!db)('merge conflict signals (PostgreSQL)', () => {
  it('queues merge checks only while the conflict rule is on', async () => {
    await agentPullRequest();
    await webhook('push', {
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/app' },
    });
    expect((await rows(db!, 'pull_requests'))[0]?.merge_check_after).toBeNull();

    await enableRules({ 'github.conflict': { enabled: true } });
    await webhook('push', {
      ref: 'refs/heads/other',
      repository: { full_name: 'acme/app' },
    });
    expect((await rows(db!, 'pull_requests'))[0]?.merge_check_after).toBeNull();
    await webhook('push', {
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/app' },
    });
    expect(
      (await rows(db!, 'pull_requests'))[0]?.merge_check_after,
    ).not.toBeNull();
  });

  it('reads the PR again while GitHub computes, then wakes the executor on a conflict', async () => {
    const { issue } = await agentPullRequest();
    await enableRules({ 'github.conflict': { enabled: true } });
    await webhook('push', {
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/app' },
    });
    const later = new Date(Date.now() + 60_000);

    github.getPullRequest.mockImplementation(async () =>
      prPayload({ mergeable: null, mergeable_state: 'unknown' }),
    );
    expect(await services.webhooks.checkMerges(later)).toBe(1);
    expect((await rows(db!, 'pull_requests'))[0]).toMatchObject({
      merge_check_attempts: 1,
    });
    expect(await signalTriggers()).toEqual([]);
    // Not due yet.
    expect(await services.webhooks.checkMerges(later)).toBe(0);

    github.getPullRequest.mockImplementation(async () =>
      prPayload({ mergeable: false, mergeable_state: 'dirty' }),
    );
    expect(
      await services.webhooks.checkMerges(new Date(later.getTime() + 60_000)),
    ).toBe(1);
    expect((await rows(db!, 'pull_requests'))[0]).toMatchObject({
      merge_check_after: null,
      merge_check_attempts: 0,
      mergeable_state: 'dirty',
    });
    const [trigger] = await signalTriggers();
    expect(trigger?.payload).toMatchObject({
      kind: 'github.conflict',
      key: 'acme/app#5@head1',
      title: 'Merge conflicts on acme/app#5',
      instruction: expect.stringContaining('conflicts with `main`'),
    });
    expect(await signalActivities('signal_received')).toEqual([
      expect.objectContaining({ issue_id: issue.id }),
    ]);

    // The agent merged main in: the new head is clean and the streak ends.
    github.getPullRequest.mockImplementation(async () =>
      prPayload({ head: { ref: 'feature/login', sha: 'head2' } }),
    );
    await pushHead('head2');
    expect(
      await services.webhooks.checkMerges(new Date(Date.now() + 60_000)),
    ).toBe(1);
    expect(await signalActivities('signal_resolved')).toHaveLength(1);
  });

  it('gives up quietly after repeated failures to read GitHub', async () => {
    await agentPullRequest();
    await enableRules({ 'github.conflict': { enabled: true } });
    await pushHead('head2');
    github.getPullRequest.mockImplementation(async () => {
      throw new Error('GitHub is down');
    });
    let at = Date.now();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      at += 60_000;
      await services.webhooks.checkMerges(new Date(at));
    }
    expect((await rows(db!, 'pull_requests'))[0]).toMatchObject({
      merge_check_after: null,
      merge_check_attempts: 0,
    });
    expect(await signalTriggers()).toEqual([]);
  });
});
