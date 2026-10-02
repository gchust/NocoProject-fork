/**
 * The few GitHub REST calls NocoProject makes (docs/phase1/iteration-2-contract.md §C). Everything goes through the
 * `GitHubClient` interface so tests use a fake; the real client uses `fetch`. Tokens travel only in the
 * Authorization header and never appear in errors or logs.
 */
import type {
  PullRequestCiState,
  PullRequestState,
} from '../shared/protocol.js';
import { pullRequestStateOf } from './link-rules.js';

export interface GitHubCredentials {
  readonly apiBaseUrl: string;
  readonly token: string;
}

/** The fields NocoProject reads from a GitHub pull request object (REST response and webhook payload alike). */
export interface GitHubPullRequestPayload {
  readonly number?: number;
  readonly html_url?: string;
  readonly title?: string;
  readonly body?: string | null;
  readonly state?: string;
  readonly draft?: boolean;
  readonly merged?: boolean;
  readonly merged_at?: string | null;
  readonly closed_at?: string | null;
  readonly head?: { readonly ref?: string; readonly sha?: string };
  readonly base?: {
    readonly ref?: string;
    readonly repo?: { readonly full_name?: string };
  };
  readonly user?: { readonly login?: string };
  readonly additions?: number;
  readonly deletions?: number;
  readonly changed_files?: number;
  readonly mergeable_state?: string | null;
  /** null while GitHub computes it */
  readonly mergeable?: boolean | null;
}

/** The latest GitHub Actions run of a commit and its `screenshots` artifact (web URLs). */
export interface CiRunLinks {
  readonly runUrl: string;
  readonly screenshotsUrl: string | null;
}

export interface MergePullRequestInput {
  /** GitHub refuses with 409 when the head moved past this commit. */
  readonly sha: string;
  readonly commitTitle: string;
}

export interface GitHubClient {
  getAuthenticatedUser(
    credentials: GitHubCredentials,
  ): Promise<{ login: string; scopes: string[] }>;
  /** The repository as the token sees it (404 when it cannot); `push` is the token user's write permission. */
  getRepository(
    credentials: GitHubCredentials,
    repo: string,
  ): Promise<{ fullName: string; push: boolean }>;
  getPullRequest(
    credentials: GitHubCredentials,
    repo: string,
    number: number,
  ): Promise<GitHubPullRequestPayload>;
  /** Combined commit status and check suites for a commit; null when there are none. */
  getCiState(
    credentials: GitHubCredentials,
    repo: string,
    sha: string,
  ): Promise<PullRequestCiState | null>;
  /** Squash-merges the pull request; returns the merge commit SHA. */
  mergePullRequest(
    credentials: GitHubCredentials,
    repo: string,
    number: number,
    input: MergePullRequestInput,
  ): Promise<{ sha: string }>;
  /** The latest Actions run for a commit; null when there is none. */
  getLatestCiRun(
    credentials: GitHubCredentials,
    repo: string,
    sha: string,
  ): Promise<CiRunLinks | null>;
}

export class GitHubApiError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/** What a snapshot of a pull request stores (the `pullRequests` columns). */
export interface PullRequestSnapshot {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: PullRequestState;
  readonly draft: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly authorLogin: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly mergeableState: string | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  /** Only the REST refresh knows it; webhooks keep the stored value. */
  readonly ciState?: PullRequestCiState | null;
  /** Only the REST refresh knows them; webhooks keep the stored values. */
  readonly ciRunUrl?: string | null;
  readonly screenshotsUrl?: string | null;
  readonly body: string | null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

export function snapshotFromPayload(
  payload: GitHubPullRequestPayload,
  repo: string,
  number: number,
): PullRequestSnapshot {
  return {
    repo,
    number,
    url:
      typeof payload.html_url === 'string' && payload.html_url
        ? payload.html_url
        : `https://github.com/${repo}/pull/${number}`,
    title: (payload.title ?? '').slice(0, 500),
    state: pullRequestStateOf(payload.state, payload.merged, payload.merged_at),
    draft: payload.draft === true,
    headRef: (payload.head?.ref ?? '').slice(0, 255),
    baseRef: (payload.base?.ref ?? '').slice(0, 255),
    headSha: (payload.head?.sha ?? '').slice(0, 64),
    authorLogin: (payload.user?.login ?? '').slice(0, 255),
    additions: count(payload.additions),
    deletions: count(payload.deletions),
    changedFiles: count(payload.changed_files),
    mergeableState:
      typeof payload.mergeable_state === 'string'
        ? payload.mergeable_state.slice(0, 32)
        : null,
    mergedAt: payload.merged_at ?? null,
    closedAt: payload.closed_at ?? null,
    body: typeof payload.body === 'string' ? payload.body : null,
  };
}

/** Folds commit statuses and check-suite conclusions into one CI state. */
export function combineCiStates(
  states: readonly (PullRequestCiState | null)[],
): PullRequestCiState | null {
  const known = states.filter(
    (state): state is PullRequestCiState => state !== null,
  );
  if (known.length === 0) return null;
  if (known.includes('failure')) return 'failure';
  if (known.includes('pending')) return 'pending';
  return 'success';
}

/** A commit status `state` (pending / success / failure / error). */
export function ciStateOfStatus(state: unknown): PullRequestCiState | null {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  if (state === 'failure' || state === 'error') return 'failure';
  return null;
}

/** The check-suite fields the CI state reads, from the REST API and the `check_suite` webhook alike. */
export type CheckSuiteFields = {
  status?: unknown;
  conclusion?: unknown;
  latest_check_runs_count?: unknown;
};

/**
 * A check-suite `status` + `conclusion`. A suite without check runs counts as no CI (null), as on GitHub's own
 * pages: some GitHub Apps create a suite for every commit and never run anything, so it stays `queued` forever.
 */
export function ciStateOfCheckSuite(
  suite: CheckSuiteFields | undefined,
): PullRequestCiState | null {
  if (!suite || suite.latest_check_runs_count === 0) return null;
  const { status, conclusion } = suite;
  if (status !== undefined && status !== null && status !== 'completed')
    return 'pending';
  if (
    conclusion === 'success' ||
    conclusion === 'neutral' ||
    conclusion === 'skipped'
  )
    return 'success';
  if (conclusion === null || conclusion === undefined) return null;
  return 'failure';
}

/** The artifact `.github/workflows/ci.yml` uploads from `pnpm screenshots`. */
export const SCREENSHOTS_ARTIFACT = 'screenshots';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createFetchGitHubClient(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): GitHubClient {
  async function request(
    credentials: GitHubCredentials,
    path: string,
    init: { method?: 'GET' | 'PUT'; body?: unknown } = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    const base = credentials.apiBaseUrl.replace(/\/+$/u, '');
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${credentials.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'nocoproject',
          ...(init.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitHubApiError(0, 'GitHub could not be reached.');
    }
    if (!response.ok)
      throw new GitHubApiError(
        response.status,
        `GitHub answered ${response.status}.`,
      );
    return { body: await response.json(), headers: response.headers };
  }

  return {
    async getAuthenticatedUser(credentials) {
      const { body, headers } = await request(credentials, '/user');
      const scopes = (headers.get('x-oauth-scopes') ?? '')
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      const login = (body as { login?: unknown }).login;
      return { login: typeof login === 'string' ? login : '', scopes };
    },
    async getRepository(credentials, repo) {
      const { body } = await request(credentials, `/repos/${repo}`);
      const { full_name: fullName, permissions } = body as {
        full_name?: unknown;
        permissions?: { push?: unknown };
      };
      return {
        fullName: typeof fullName === 'string' && fullName ? fullName : repo,
        push: permissions?.push === true,
      };
    },
    async getPullRequest(credentials, repo, number) {
      const { body } = await request(
        credentials,
        `/repos/${repo}/pulls/${number}`,
      );
      return body as GitHubPullRequestPayload;
    },
    async getCiState(credentials, repo, sha) {
      const status = await request(
        credentials,
        `/repos/${repo}/commits/${sha}/status`,
      );
      const suites = await request(
        credentials,
        `/repos/${repo}/commits/${sha}/check-suites`,
      );
      const combined = status.body as {
        state?: unknown;
        total_count?: unknown;
      };
      const list =
        (
          suites.body as {
            check_suites?: CheckSuiteFields[];
          }
        ).check_suites ?? [];
      return combineCiStates([
        Number(combined.total_count ?? 0) > 0
          ? ciStateOfStatus(combined.state)
          : null,
        ...list.map(ciStateOfCheckSuite),
      ]);
    },
    async mergePullRequest(credentials, repo, number, input) {
      const { body } = await request(
        credentials,
        `/repos/${repo}/pulls/${number}/merge`,
        {
          method: 'PUT',
          body: {
            merge_method: 'squash',
            sha: input.sha,
            commit_title: input.commitTitle,
          },
        },
      );
      const sha = (body as { sha?: unknown }).sha;
      return { sha: typeof sha === 'string' ? sha : '' };
    },
    async getLatestCiRun(credentials, repo, sha) {
      const runs = await request(
        credentials,
        `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=1`,
      );
      const run = (
        runs.body as { workflow_runs?: { id?: unknown; html_url?: unknown }[] }
      ).workflow_runs?.[0];
      if (!run || typeof run.html_url !== 'string') return null;
      const artifacts = await request(
        credentials,
        `/repos/${repo}/actions/runs/${String(run.id)}/artifacts`,
      );
      return ciRunLinksOf(
        run.html_url,
        (artifacts.body as { artifacts?: unknown[] }).artifacts ?? [],
      );
    },
  };
}

/** The run page and its unexpired `screenshots` artifact (`<run page>/artifacts/<id>`). */
export function ciRunLinksOf(
  runUrl: string,
  artifacts: readonly unknown[],
): CiRunLinks {
  const screenshots = artifacts.find(
    (item): item is { id: number } =>
      !!item &&
      typeof item === 'object' &&
      (item as { name?: unknown }).name === SCREENSHOTS_ARTIFACT &&
      (item as { expired?: unknown }).expired !== true &&
      typeof (item as { id?: unknown }).id === 'number',
  );
  const base = runUrl.replace(/\/+$/u, '');
  return {
    runUrl: base,
    screenshotsUrl: screenshots ? `${base}/artifacts/${screenshots.id}` : null,
  };
}
