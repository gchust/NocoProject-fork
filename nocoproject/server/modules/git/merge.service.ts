/**
 * Merging a linked pull request from the issue page or the inbox (NP-85, docs/phase1/protocol-iteration-4.md).
 *
 * Who: the issue owner, the project lead, owner/admin (`canMergePullRequest`); run tokens never reach the browser
 * routes, and any actor that is not a member is refused here too. An issue the caller cannot see is 404.
 *
 * Both calls read the pull request and its checks from GitHub first (never the stored snapshot) and store what they
 * saw — except a move out of `open`, which stays the webhook's (`upsertPullRequest` `keepOpenState`). The merge is
 * always a squash of the head the member confirmed (`sha`), titled `<title> (#<number>)`. The issue status is not
 * touched: GitHub's `pull_request closed` webhook runs the merge flow (`merge-flow.ts`), as for a merge on GitHub.
 * Errors never carry GitHub's text or the token.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  canMergePullRequest,
  forbid,
  requireVisibleIssue,
  viewerOf,
} from '../shared/authz.js';
import type { SecretBox } from '../shared/crypto.js';
import type { TxRunner } from '../shared/db.js';
import { bool } from '../shared/db.js';
import { conflict, invalid, NpError, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import {
  ERROR_GITHUB_MERGE_FORBIDDEN,
  ERROR_PR_CHANGED,
  ERROR_PR_NOT_MERGEABLE,
  type IssueV4,
  type MergePullRequestResponse,
  type PullRequest,
  type PullRequestMergeBlocker,
  type PullRequestMergePreflight,
} from '../shared/protocol.js';
import type { SettingsService } from '../system/settings.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import { githubError } from './connection.service.js';
import { GitHubApiError, type GitHubClient } from './github-client.js';
import { findPullRequestById, upsertPullRequest } from './git.records.js';
import { mergeOutcome } from './merge-flow.js';
import { mergeBlockerOf, mergeCommitTitle } from './merge-rules.js';
import { fetchSnapshot } from './pull-request.service.js';

export interface PullRequestMergeService {
  preflight(
    actor: Actor,
    issueIdOrKey: string,
    pullRequestId: string,
  ): Promise<PullRequestMergePreflight>;
  merge(
    actor: Actor,
    issueIdOrKey: string,
    pullRequestId: string,
    expectedHeadSha: unknown,
  ): Promise<MergePullRequestResponse>;
}

export interface PullRequestMergeDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly activity: ActivityRecorder;
  readonly secrets: SecretBox;
  readonly github: GitHubClient;
  readonly settings: SettingsService;
  readonly workflows: WorkflowService;
}

interface Checked {
  readonly issue: IssueV4;
  readonly pr: PullRequest;
  readonly preflight: PullRequestMergePreflight;
  readonly credentials: Awaited<
    ReturnType<typeof fetchSnapshot>
  >['credentials'];
}

function notMergeable(blocker: PullRequestMergeBlocker): NpError {
  return new NpError(
    'conflict',
    ERROR_PR_NOT_MERGEABLE,
    `The pull request cannot be merged (${blocker}).`,
    { blocker },
  );
}

function prChanged(): NpError {
  return conflict(
    ERROR_PR_CHANGED,
    'The pull request has new commits; review it again before merging.',
  );
}

/** GitHub's answer to the merge call; its body is never echoed. */
function mergeError(error: unknown): NpError {
  if (error instanceof GitHubApiError) {
    // The read just succeeded, so a 404 here is a fine-grained token without write access.
    if (error.status === 403 || error.status === 404)
      return conflict(
        ERROR_GITHUB_MERGE_FORBIDDEN,
        'The GitHub token needs write access to Contents and Pull requests.',
      );
    if (error.status === 405) return notMergeable('protected');
    if (error.status === 409) return prChanged();
  }
  return githubError(error);
}

async function requireLinked(
  deps: PullRequestMergeDeps,
  actor: Actor,
  idOrKey: string,
  pullRequestId: string,
): Promise<{ issue: IssueV4; pr: PullRequest; autoCompleteDisabled: boolean }> {
  if (actor.type !== 'user')
    forbid('Only a signed-in member may merge a pull request.');
  const conn = deps.tx.read();
  const viewer = await viewerOf(conn, actor);
  const issue = await requireVisibleIssue(conn, viewer, idOrKey);
  const link = await conn.query
    .selectFrom('issuePullRequests')
    .select('autoCompleteDisabled')
    .where('issueId', '=', issue.id)
    .where('pullRequestId', '=', pullRequestId)
    .executeTakeFirst();
  const pr = link ? await findPullRequestById(conn, pullRequestId) : null;
  if (!link || !pr) throw notFound('Pull request link');
  if (!(await canMergePullRequest(conn, viewer, issue)))
    forbid(
      'Only the issue owner, the project lead or an owner/admin may merge.',
    );
  return {
    issue,
    pr,
    autoCompleteDisabled: bool(link.autoCompleteDisabled),
  };
}

async function check(
  deps: PullRequestMergeDeps,
  actor: Actor,
  idOrKey: string,
  pullRequestId: string,
): Promise<Checked | { preflight: PullRequestMergePreflight }> {
  const { issue, pr, autoCompleteDisabled } = await requireLinked(
    deps,
    actor,
    idOrKey,
    pullRequestId,
  );
  const statusAfter = await mergeOutcome(
    deps,
    deps.tx.read(),
    issue,
    pr.id,
    autoCompleteDisabled,
  );
  const base = {
    method: 'squash' as const,
    commitTitle: mergeCommitTitle(pr),
    statusAfter,
  };
  let fresh: Awaited<ReturnType<typeof fetchSnapshot>>;
  try {
    fresh = await fetchSnapshot(deps, pr);
  } catch (error) {
    if (error instanceof NpError && error.code === 'GITHUB_NOT_CONFIGURED')
      return {
        preflight: {
          ...base,
          blocker: 'notConfigured',
          headSha: pr.headSha,
          baseRef: pr.baseRef,
        },
      };
    throw error;
  }
  const stored = await deps.tx.run(async (tx) => {
    const { pr: saved } = await upsertPullRequest(
      tx,
      deps.ids,
      fresh.snapshot,
      fresh.connectionId,
      { keepOpenState: true },
    );
    tx.emit({ type: 'issue.changed', issueId: issue.id });
    return saved;
  });
  const blocker = mergeBlockerOf(
    { ...fresh.snapshot, ciState: fresh.snapshot.ciState ?? null },
    fresh.payload.mergeable ?? null,
  );
  return {
    issue,
    pr: stored,
    credentials: fresh.credentials,
    preflight: {
      ...base,
      commitTitle: mergeCommitTitle(fresh.snapshot),
      blocker,
      headSha: fresh.snapshot.headSha,
      baseRef: fresh.snapshot.baseRef,
    },
  };
}

async function merge(
  deps: PullRequestMergeDeps,
  actor: Actor,
  idOrKey: string,
  pullRequestId: string,
  expectedHeadSha: unknown,
): Promise<MergePullRequestResponse> {
  if (typeof expectedHeadSha !== 'string' || expectedHeadSha.trim() === '')
    throw invalid(
      'INVALID_EXPECTED_HEAD',
      'expectedHeadSha must be the head commit shown when confirming.',
    );
  const checked = await check(deps, actor, idOrKey, pullRequestId);
  const { preflight } = checked;
  if (preflight.blocker) throw notMergeable(preflight.blocker);
  if (!('issue' in checked)) throw notMergeable('notConfigured');
  if (preflight.headSha !== expectedHeadSha.trim()) throw prChanged();
  const { issue, pr, credentials } = checked;
  let sha: string;
  try {
    ({ sha } = await deps.github.mergePullRequest(
      credentials,
      pr.repo,
      pr.number,
      { sha: preflight.headSha, commitTitle: preflight.commitTitle },
    ));
  } catch (error) {
    throw mergeError(error);
  }
  await deps.tx.run(async (tx) => {
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action: 'pr_merge_requested',
      details: {
        pullRequestId: pr.id,
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        sha: preflight.headSha,
        method: 'squash',
      },
    });
    tx.emit({ type: 'issue.changed', issueId: issue.id });
  });
  return { merged: true, sha };
}

export function createPullRequestMergeService(
  deps: PullRequestMergeDeps,
): PullRequestMergeService {
  return {
    async preflight(actor, idOrKey, pullRequestId) {
      return (await check(deps, actor, idOrKey, pullRequestId)).preflight;
    },
    merge: (actor, idOrKey, pullRequestId, expectedHeadSha) =>
      merge(deps, actor, idOrKey, pullRequestId, expectedHeadSha),
  };
}
