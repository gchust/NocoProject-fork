/**
 * Entry conditions of a transition (NP-77 proposal §1, §2), checked inside the transaction before the approval gate and
 * before anything is written:
 *
 * - `requirePrMerged` on the target status: at least `minCount` (default 1) pull requests linked to the issue are
 *   merged, else 409 `STAGE_PR_NOT_MERGED`;
 * - a checklist of the status being left: every required item is checked, else 409 `CHECKLIST_INCOMPLETE` — unless
 *   the target is a `closed` status (cancelling is never held up).
 *
 * System writes (a merged pull request, a failed run's reset) skip them. Human PATCH, agent status writes and the
 * transition an approver accepts all call `assertStageGuards`; the approval path uses `stageGuardFailure` so it can
 * mark the request stale instead of failing.
 */
import type { Actor } from '../shared/activity.js';
import type { Conn } from '../shared/db.js';
import { unique } from '../shared/db.js';
import { conflict, type NpError } from '../shared/errors.js';
import type { IssueV1 } from '../shared/protocol.js';
import {
  ERROR_CHECKLIST_INCOMPLETE,
  ERROR_STAGE_PR_NOT_MERGED,
} from '../shared/protocol.js';
import type { WorkflowView } from '../issue/status.js';
import { incompleteRequiredItems } from './checklist.js';

async function mergedPullRequestCount(
  conn: Conn,
  issueId: string,
): Promise<number> {
  const links = await conn.query
    .selectFrom('issuePullRequests')
    .select('pullRequestId')
    .where('issueId', '=', issueId)
    .execute();
  const ids = unique(links.map((row) => String(row.pullRequestId)));
  if (ids.length === 0) return 0;
  const merged = await conn.query
    .selectFrom('pullRequests')
    .select('id')
    .where('id', 'in', ids)
    .where('state', '=', 'merged')
    .execute();
  return merged.length;
}

/** The first entry condition `before.statusKey → target` fails, or null. */
export async function stageGuardFailure(
  conn: Conn,
  view: WorkflowView,
  before: IssueV1,
  target: string,
  actor: Actor,
): Promise<NpError | null> {
  if (actor.type === 'system' || before.statusKey === target) return null;
  if (view.category(target) !== 'closed') {
    const missing = await incompleteRequiredItems(
      conn,
      before.id,
      before.statusKey,
    );
    if (missing.length > 0)
      return conflict(
        ERROR_CHECKLIST_INCOMPLETE,
        `Check the required checklist items of ${before.statusKey} first: ${missing.join('; ')}.`,
      );
  }
  for (const action of view.stageActions(target)) {
    if (action.type !== 'requirePrMerged') continue;
    const needed = action.minCount ?? 1;
    const merged = await mergedPullRequestCount(conn, before.id);
    if (merged < needed)
      return conflict(
        ERROR_STAGE_PR_NOT_MERGED,
        `${target} requires ${needed} merged pull request(s) linked to ${before.identifier}; ${merged} merged.`,
      );
  }
  return null;
}

export async function assertStageGuards(
  conn: Conn,
  view: WorkflowView,
  before: IssueV1,
  target: string,
  actor: Actor,
): Promise<void> {
  const failure = await stageGuardFailure(conn, view, before, target, actor);
  if (failure) throw failure;
}
