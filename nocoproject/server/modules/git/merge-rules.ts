/**
 * When a linked pull request may be merged from NocoProject (NP-85, docs/phase1/protocol-iteration-4.md): open, not a
 * draft, no conflicts, every check passed. Pure, so the merge service (fresh GitHub state) and the inbox (stored
 * snapshot) read the same rule.
 */
import type {
  PullRequest,
  PullRequestMergeBlocker,
} from '../shared/protocol.js';

/**
 * The first reason the PR cannot be merged, or null. `mergeable` is GitHub's fresh flag (null while GitHub computes
 * it); `undefined` means "stored snapshot only", where only `mergeableState = dirty` counts as a conflict.
 */
export function mergeBlockerOf(
  pr: Pick<PullRequest, 'state' | 'draft' | 'mergeableState' | 'ciState'>,
  mergeable?: boolean | null,
): PullRequestMergeBlocker | null {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  if (mergeable === false || pr.mergeableState === 'dirty') return 'conflicts';
  if (mergeable === null) return 'computing';
  if (pr.ciState === 'pending') return 'ciPending';
  if (pr.ciState === 'failure') return 'ciFailed';
  if (pr.ciState !== 'success') return 'ciMissing';
  return null;
}

/** The squash commit title: `<PR title> (#<number>)`. */
export function mergeCommitTitle(
  pr: Pick<PullRequest, 'title' | 'number'>,
): string {
  const title = pr.title.trim() || 'Merge pull request';
  return `${title} (#${pr.number})`;
}
