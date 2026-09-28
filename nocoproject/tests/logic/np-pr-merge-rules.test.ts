// @vitest-environment node
/**
 * The pure parts of merging from NocoProject (NP-85): the merge blockers, the squash commit title, and the fetch
 * client's merge and CI run calls (a fake `fetch`; GitHub itself is never called).
 */
import { describe, expect, it } from 'vitest';

import {
  ciRunLinksOf,
  createFetchGitHubClient,
  GitHubApiError,
} from '../../server/modules/git/github-client.ts';
import {
  mergeBlockerOf,
  mergeCommitTitle,
} from '../../server/modules/git/merge-rules.ts';

const CREDENTIALS = {
  apiBaseUrl: 'https://api.github.com/',
  token: 'ghp_secret',
};

function fakeFetch(
  answers: Record<string, { status?: number; body: unknown }>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[url] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createFetchGitHubClient(fetchImpl) };
}

describe('merge blockers (pure)', () => {
  const pr = {
    state: 'open' as const,
    draft: false,
    mergeableState: 'clean',
    ciState: 'success' as const,
  };

  it('allows an open, ready, conflict-free PR whose checks passed', () => {
    expect(mergeBlockerOf(pr, true)).toBeNull();
    expect(mergeBlockerOf(pr)).toBeNull();
    // Branch protection is GitHub's call (405 → protected), not ours.
    expect(
      mergeBlockerOf({ ...pr, mergeableState: 'blocked' }, true),
    ).toBeNull();
  });

  it('names the first reason in order', () => {
    expect(mergeBlockerOf({ ...pr, state: 'merged', draft: true })).toBe(
      'merged',
    );
    expect(mergeBlockerOf({ ...pr, state: 'closed' })).toBe('closed');
    expect(mergeBlockerOf({ ...pr, draft: true }, false)).toBe('draft');
    expect(mergeBlockerOf(pr, false)).toBe('conflicts');
    expect(mergeBlockerOf({ ...pr, mergeableState: 'dirty' })).toBe(
      'conflicts',
    );
    expect(mergeBlockerOf(pr, null)).toBe('computing');
    expect(mergeBlockerOf({ ...pr, ciState: 'pending' }, true)).toBe(
      'ciPending',
    );
    expect(mergeBlockerOf({ ...pr, ciState: 'failure' }, true)).toBe(
      'ciFailed',
    );
    expect(mergeBlockerOf({ ...pr, ciState: null }, true)).toBe('ciMissing');
  });

  it('titles the squash commit with the PR number', () => {
    expect(mergeCommitTitle({ title: ' Add login ', number: 12 })).toBe(
      'Add login (#12)',
    );
    expect(mergeCommitTitle({ title: '', number: 3 })).toBe(
      'Merge pull request (#3)',
    );
  });
});

describe('fetch GitHub client: merge and CI runs', () => {
  it('squash-merges with PUT, the head SHA and the title; the token only in the header', async () => {
    const { calls, client } = fakeFetch({
      'https://api.github.com/repos/acme/app/pulls/5/merge': {
        body: { sha: 'm1', merged: true },
      },
    });
    await expect(
      client.mergePullRequest(CREDENTIALS, 'acme/app', 5, {
        sha: 'head1',
        commitTitle: 'Add login (#5)',
      }),
    ).resolves.toEqual({ sha: 'm1' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.init.method).toBe('PUT');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      merge_method: 'squash',
      sha: 'head1',
      commit_title: 'Add login (#5)',
    });
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer ghp_secret',
      'content-type': 'application/json',
    });
    expect(call?.url).not.toContain('ghp_secret');
  });

  it('raises the status without the body on failure', async () => {
    const { client } = fakeFetch({
      'https://api.github.com/repos/acme/app/pulls/5/merge': {
        status: 405,
        body: { message: 'Pull Request is not mergeable ghp_secret' },
      },
    });
    const error = await client
      .mergePullRequest(CREDENTIALS, 'acme/app', 5, {
        sha: 'h',
        commitTitle: 't',
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 405 });
    expect(String((error as Error).message)).not.toContain('ghp_secret');
  });

  it('finds the latest run of a commit and its screenshots artifact', async () => {
    const { calls, client } = fakeFetch({
      'https://api.github.com/repos/acme/app/actions/runs?head_sha=abc&per_page=1':
        {
          body: {
            workflow_runs: [
              {
                id: 77,
                html_url: 'https://github.com/acme/app/actions/runs/77',
              },
            ],
          },
        },
      'https://api.github.com/repos/acme/app/actions/runs/77/artifacts': {
        body: {
          artifacts: [
            { id: 1, name: 'coverage', expired: false },
            { id: 9, name: 'screenshots', expired: false },
          ],
        },
      },
    });
    await expect(
      client.getLatestCiRun(CREDENTIALS, 'acme/app', 'abc'),
    ).resolves.toEqual({
      runUrl: 'https://github.com/acme/app/actions/runs/77',
      screenshotsUrl: 'https://github.com/acme/app/actions/runs/77/artifacts/9',
    });
    expect(calls.every((call) => (call.init.method ?? 'GET') === 'GET')).toBe(
      true,
    );
  });

  it('answers null without runs, and skips expired or missing screenshots', async () => {
    const { client } = fakeFetch({
      'https://api.github.com/repos/acme/app/actions/runs?head_sha=none&per_page=1':
        { body: { workflow_runs: [] } },
    });
    await expect(
      client.getLatestCiRun(CREDENTIALS, 'acme/app', 'none'),
    ).resolves.toBeNull();
    expect(
      ciRunLinksOf('https://github.com/a/b/actions/runs/1/', [
        { id: 2, name: 'screenshots', expired: true },
      ]),
    ).toEqual({
      runUrl: 'https://github.com/a/b/actions/runs/1',
      screenshotsUrl: null,
    });
  });
});
