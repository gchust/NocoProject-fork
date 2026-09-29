import { ApiClientError } from '@nocobase/app-client';

import type { NpTone } from '@/components/np-tones';
import type {
  CiState,
  PullRequest,
  PullRequestBadgeState,
} from '../../types.js';
import type { MergeBlocker } from '../../types-iter4.js';

/**
 * How a PR card reads a pull request snapshot (iteration 2 §C). Pure, so the four badge states and the CI and
 * mergeable readings are tested without rendering.
 */

/** open / draft / merged / closed; `draft` only while the PR is open, and a merged PR never reads as closed. */
export function prBadgeState(
  pr: Pick<PullRequest, 'state' | 'draft' | 'mergedAt'>,
): PullRequestBadgeState {
  if (pr.state === 'merged' || pr.mergedAt) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.draft ? 'draft' : 'open';
}

/** PR state tones (nocosolution/NocoSolution 前端规范.md §S7.2): open green, draft grey, merged violet, closed slate. */
export const PR_TONE: Readonly<Record<PullRequestBadgeState, NpTone>> = {
  open: 'green',
  draft: 'grey',
  merged: 'violet',
  closed: 'slate',
};

export type CiReading = CiState | 'none';

export function ciReading(ciState: CiState | null | undefined): CiReading {
  return ciState ?? 'none';
}

/**
 * GitHub's `mergeable_state` folded into what a reader acts on: `clean` / `unstable` / `has_hooks` can merge,
 * `dirty` has conflicts, `blocked` waits for reviews or checks, `behind` needs an update, anything else (`unknown`,
 * `draft`, null while GitHub computes it) is unknown.
 */
export type MergeableReading =
  'mergeable' | 'conflicts' | 'blocked' | 'behind' | 'unknown';

export function mergeableReading(
  state: string | null | undefined,
): MergeableReading {
  switch (state) {
    case 'clean':
    case 'unstable':
    case 'has_hooks':
      return 'mergeable';
    case 'dirty':
      return 'conflicts';
    case 'blocked':
      return 'blocked';
    case 'behind':
      return 'behind';
    default:
      return 'unknown';
  }
}

/** Whether the PR still counts towards auto-completing the issue: open or merged and not opted out. */
export function isPrFinished(
  pr: Pick<PullRequest, 'state' | 'mergedAt'>,
): boolean {
  return pr.state !== 'open' || Boolean(pr.mergedAt);
}

/** A GitHub pull request URL, as the server's `INVALID_PR_URL` check reads it: `/owner/repo/pull/<n>`. */
export function looksLikePullRequestUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/u.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * NP-85: why the stored snapshot says the PR cannot be merged yet, in the server's order (merged, closed, draft,
 * conflicts, CI). Only a hint for the button: the confirm dialog asks GitHub again before anything is merged.
 */
export function mergeBlockerOf(
  pr: Pick<
    PullRequest,
    'state' | 'draft' | 'mergedAt' | 'mergeableState' | 'ciState'
  >,
): MergeBlocker | null {
  const state = prBadgeState(pr);
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  if (state === 'draft') return 'draft';
  if (pr.mergeableState === 'dirty') return 'conflicts';
  if (pr.ciState === 'pending') return 'ciPending';
  if (pr.ciState === 'failure') return 'ciFailed';
  if (pr.ciState !== 'success') return 'ciMissing';
  return null;
}

/** NP-133: the server's GitHub error codes (`githubError`, `fetchSnapshot`) and the sentence each one reads as. */
const GITHUB_FAILURE = {
  GITHUB_NOT_CONFIGURED: 'notConfigured',
  GITHUB_AUTH_FAILED: 'authFailed',
  GITHUB_NOT_FOUND: 'notFound',
  GITHUB_REQUEST_FAILED: 'requestFailed',
} as const;

/**
 * Why a GitHub call behind a PR refresh, link, merge check or merge failed, with the next step; null for anything
 * that is not a GitHub error, so the caller keeps its own wording or the generic "request failed".
 */
export function githubErrorText(
  t: (key: string) => string,
  error: unknown,
): string | null {
  if (!(error instanceof ApiClientError)) return null;
  const code = error.code;
  if (!code || !Object.hasOwn(GITHUB_FAILURE, code)) return null;
  const failure = GITHUB_FAILURE[code as keyof typeof GITHUB_FAILURE];
  return t(`np.pullRequests.githubError.${failure}`);
}
