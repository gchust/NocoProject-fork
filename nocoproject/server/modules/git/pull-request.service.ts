/**
 * Linking pull requests to issues by hand (browser) and from an agent's run (docs/phase1/iteration-2-contract.md §C).
 *
 * Browser: any member who can see the issue. Linking fetches the pull request with the stored token (409
 * `GITHUB_NOT_CONFIGURED` without one); unlinking keeps the PR row. Agent: writes only to its run's issue; without a
 * token (or when GitHub cannot be read) a minimal open row is stored for the webhook to complete.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  canMergePullRequest,
  requireVisibleIssue,
  viewerOf,
} from '../shared/authz.js';
import type { SecretBox } from '../shared/crypto.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { now } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  IssuePullRequestView,
  IssuePullRequestViewV4,
  IssueV1,
  PullRequest,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { validateBoolean } from '../shared/validate.js';
import {
  credentialsOf,
  githubError,
  loadConnection,
} from './connection.service.js';
import {
  snapshotFromPayload,
  type GitHubClient,
  type GitHubCredentials,
} from './github-client.js';
import {
  ensurePullRequest,
  findPullRequestById,
  linkPullRequest,
  pullRequestsForIssue,
  upsertPullRequest,
} from './git.records.js';
import { parsePullRequestUrl, type PullRequestRef } from './link-rules.js';
import { requestReviews } from './merge-flow.js';

export interface PullRequestService {
  list(actor: Actor, issueIdOrKey: string): Promise<IssuePullRequestView[]>;
  link(
    actor: Actor,
    issueIdOrKey: string,
    url: unknown,
  ): Promise<IssuePullRequestView>;
  unlink(
    actor: Actor,
    issueIdOrKey: string,
    pullRequestId: string,
  ): Promise<void>;
  setAutoComplete(
    actor: Actor,
    issueIdOrKey: string,
    pullRequestId: string,
    autoCompleteDisabled: unknown,
  ): Promise<IssuePullRequestView>;
  refresh(
    actor: Actor,
    issueIdOrKey: string,
    pullRequestId: string,
  ): Promise<IssuePullRequestView>;
  /** The agent route: link to the run's issue (already resolved by the caller). */
  agentLink(
    actor: Actor,
    issue: IssueV1,
    url: unknown,
  ): Promise<{ view: IssuePullRequestView; created: boolean }>;
  forIssue(issueId: string): Promise<IssuePullRequestView[]>;
}

export interface PullRequestDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly secrets: SecretBox;
  readonly github: GitHubClient;
}

function requireUrl(url: unknown): PullRequestRef {
  const ref = parsePullRequestUrl(url);
  if (!ref)
    throw invalid(
      'INVALID_PR_URL',
      'url must be a pull request URL such as https://github.com/owner/repo/pull/12.',
    );
  return ref;
}

/** One linked PR as `actor` sees it (`viewerCanMerge` only for members). */
async function viewOf(
  deps: PullRequestDeps,
  tx: Tx,
  issue: IssueV1,
  pullRequestId: string,
  actor: Actor,
): Promise<IssuePullRequestViewV4> {
  const canMerge =
    actor.type === 'user' &&
    (await canMergePullRequest(tx.conn, await viewerOf(tx.conn, actor), issue));
  const view = (
    await pullRequestsForIssue(tx.conn, deps.users, issue.id, canMerge)
  ).find((item) => item.id === pullRequestId);
  if (!view) throw notFound('Pull request link');
  return view;
}

/** The latest Actions run links; a failure (or no Actions at all) is not an error. */
async function ciLinks(
  github: GitHubClient,
  credentials: GitHubCredentials,
  repo: string,
  sha: string,
): Promise<{ ciRunUrl: string | null; screenshotsUrl: string | null }> {
  const run = sha
    ? await github.getLatestCiRun(credentials, repo, sha).catch(() => null)
    : null;
  return {
    ciRunUrl: run?.runUrl ?? null,
    screenshotsUrl: run?.screenshotsUrl ?? null,
  };
}

/**
 * Full snapshot with the stored token (mergeable state, CI and its run links included), plus the raw payload (the
 * merge check reads `mergeable`). Called outside any transaction.
 */
export async function fetchSnapshot(
  deps: Pick<PullRequestDeps, 'tx' | 'secrets' | 'github'>,
  ref: Pick<PullRequestRef, 'repo' | 'number'>,
) {
  const credentials = credentialsOf(
    await loadConnection(deps.tx.read(), deps.secrets),
  );
  if (!credentials)
    throw conflict('GITHUB_NOT_CONFIGURED', 'No GitHub token is configured.');
  try {
    const payload = await deps.github.getPullRequest(
      credentials,
      ref.repo,
      ref.number,
    );
    const snapshot = snapshotFromPayload(payload, ref.repo, ref.number);
    const ciState = snapshot.headSha
      ? await deps.github.getCiState(credentials, ref.repo, snapshot.headSha)
      : null;
    const links = await ciLinks(
      deps.github,
      credentials,
      ref.repo,
      snapshot.headSha,
    );
    return {
      snapshot: { ...snapshot, ciState, ...links },
      payload,
      credentials,
      connectionId: credentials.connectionId,
    };
  } catch (error) {
    throw githubError(error);
  }
}

async function requireLink(
  tx: Tx,
  issueId: string,
  pullRequestId: string,
): Promise<void> {
  const exists = await tx.conn.query
    .selectFrom('issuePullRequests')
    .select('id')
    .where('issueId', '=', issueId)
    .where('pullRequestId', '=', pullRequestId)
    .exists();
  if (!exists) throw notFound('Pull request link');
}

async function agentLink(
  deps: PullRequestDeps,
  actor: Actor,
  issue: IssueV1,
  url: unknown,
): Promise<{ view: IssuePullRequestView; created: boolean }> {
  const ref = requireUrl(url);
  // No token, or GitHub could not be read: keep a minimal row; the webhook fills it in.
  const fetched = await fetchSnapshot(deps, ref).catch(() => null);
  return deps.tx.run(async (tx) => {
    const pr: PullRequest = fetched
      ? (
          await upsertPullRequest(
            tx,
            deps.ids,
            fetched.snapshot,
            fetched.connectionId,
          )
        ).pr
      : await ensurePullRequest(tx, deps.ids, ref);
    const created = await linkPullRequest(tx, deps, {
      issue,
      pr,
      linkedByType: 'agent',
      actor,
    });
    if (created) await requestReviews(tx, pr, [issue.id]);
    return { view: await viewOf(deps, tx, issue, pr.id, actor), created };
  });
}

export function createPullRequestService(
  deps: PullRequestDeps,
): PullRequestService {
  async function visible(
    tx: Tx,
    actor: Actor,
    idOrKey: string,
  ): Promise<IssueV1> {
    return requireVisibleIssue(
      tx.conn,
      await viewerOf(tx.conn, actor),
      idOrKey,
    );
  }

  async function list(
    actor: Actor,
    idOrKey: string,
  ): Promise<IssuePullRequestViewV4[]> {
    const conn = deps.tx.read();
    const viewer = await viewerOf(conn, actor);
    const issue = await requireVisibleIssue(conn, viewer, idOrKey);
    return pullRequestsForIssue(
      conn,
      deps.users,
      issue.id,
      await canMergePullRequest(conn, viewer, issue),
    );
  }

  return {
    list,
    async link(actor, idOrKey, url) {
      const ref = requireUrl(url);
      await list(actor, idOrKey);
      const fetched = await fetchSnapshot(deps, ref);
      return deps.tx.run(async (tx) => {
        const issue = await visible(tx, actor, idOrKey);
        const { pr } = await upsertPullRequest(
          tx,
          deps.ids,
          fetched.snapshot,
          fetched.connectionId,
        );
        await linkPullRequest(tx, deps, {
          issue,
          pr,
          linkedByType: 'user',
          actor,
        });
        return viewOf(deps, tx, issue, pr.id, actor);
      });
    },
    async unlink(actor, idOrKey, pullRequestId) {
      await deps.tx.run(async (tx) => {
        const issue = await visible(tx, actor, idOrKey);
        await requireLink(tx, issue.id, pullRequestId);
        const pr = await findPullRequestById(tx.conn, pullRequestId);
        await tx.conn.query
          .deleteFrom('issuePullRequests')
          .where('issueId', '=', issue.id)
          .where('pullRequestId', '=', pullRequestId)
          .execute();
        await deps.activity.record(tx.conn, {
          issueId: issue.id,
          actor,
          action: 'pr_unlinked',
          details: {
            pullRequestId,
            repo: pr?.repo ?? null,
            number: pr?.number ?? null,
          },
        });
        tx.emit({ type: 'issue.changed', issueId: issue.id });
      });
    },
    async setAutoComplete(actor, idOrKey, pullRequestId, autoCompleteDisabled) {
      const value = validateBoolean(
        autoCompleteDisabled,
        'autoCompleteDisabled',
      );
      return deps.tx.run(async (tx) => {
        const issue = await visible(tx, actor, idOrKey);
        await requireLink(tx, issue.id, pullRequestId);
        await tx.conn.query
          .updateTable('issuePullRequests')
          .set({ autoCompleteDisabled: value, updatedAt: now() })
          .where('issueId', '=', issue.id)
          .where('pullRequestId', '=', pullRequestId)
          .execute();
        tx.emit({ type: 'issue.changed', issueId: issue.id });
        return viewOf(deps, tx, issue, pullRequestId, actor);
      });
    },
    async refresh(actor, idOrKey, pullRequestId) {
      const linked = (await list(actor, idOrKey)).find(
        (item) => item.id === pullRequestId,
      );
      if (!linked) throw notFound('Pull request link');
      const fetched = await fetchSnapshot(deps, linked);
      return deps.tx.run(async (tx) => {
        const issue = await visible(tx, actor, idOrKey);
        await requireLink(tx, issue.id, pullRequestId);
        await upsertPullRequest(
          tx,
          deps.ids,
          fetched.snapshot,
          fetched.connectionId,
          { keepOpenState: true },
        );
        tx.emit({ type: 'issue.changed', issueId: issue.id });
        return viewOf(deps, tx, issue, pullRequestId, actor);
      });
    },
    agentLink: (actor, issue, url) => agentLink(deps, actor, issue, url),
    forIssue: (issueId) =>
      pullRequestsForIssue(deps.tx.read(), deps.users, issueId),
  };
}
