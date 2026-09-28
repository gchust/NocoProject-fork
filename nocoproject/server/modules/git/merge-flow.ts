/**
 * What a pull request's lifecycle does to its issues (docs/phase1/iteration-2-contract.md §C):
 *
 * - Merged: for each linked issue not yet terminal, when every linked PR that is not `autoCompleteDisabled` is
 *   merged, move it to `settings.prMergedStatus` (`'none'` = leave it) as the system — no approval gate, no agent
 *   transition limit. Activity `pr_merged` either way; subscribers get `pr_merged`; `pr_review` cards resolve.
 * - Closed without merge: `pr_review` cards resolve.
 * - Ready (open, not draft) on an issue executed by an agent: the owner gets the `pr_review` decision.
 */
import type { ActivityRecorder } from '../shared/activity.js';
import { SYSTEM_ACTOR } from '../shared/activity.js';
import type { Conn, Tx } from '../shared/db.js';
import { unique } from '../shared/db.js';
import type {
  IssueV1,
  PullRequest,
  PullRequestMergeKeepReason,
  PullRequestMergeOutcome,
} from '../shared/protocol.js';
import type { SettingsService } from '../system/settings.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { IssueService } from '../issue/issue.service.js';
import { findIssue, issuesByIds } from '../issue/issue.records.js';
import { linksOfPullRequest, mapPullRequest } from './git.records.js';

export interface GitFlowDeps {
  readonly activity: ActivityRecorder;
  readonly settings: SettingsService;
  readonly workflows: WorkflowService;
  readonly issues: () => IssueService;
}

/**
 * Whether every non-disabled PR linked to the issue is merged (false when there is none). `assumeMerged`: count that
 * PR as merged (what merging it would do).
 */
async function allLinkedMerged(
  tx: Pick<Tx, 'conn'>,
  issueId: string,
  assumeMerged: string | null = null,
): Promise<boolean> {
  const links = await tx.conn.query
    .selectFrom('issuePullRequests')
    .select(['pullRequestId', 'autoCompleteDisabled'])
    .where('issueId', '=', issueId)
    .execute();
  const counted = links
    .filter((row) => !row.autoCompleteDisabled)
    .map((row) => String(row.pullRequestId));
  if (counted.length === 0) return false;
  const rows = await tx.conn.query
    .selectFrom('pullRequests')
    .selectAll()
    .where('id', 'in', unique(counted))
    .execute();
  return (
    rows.length === unique(counted).length &&
    rows
      .map(mapPullRequest)
      .every((pr) => pr.id === assumeMerged || pr.state === 'merged')
  );
}

/** What merging `pullRequestId` would do to the issue (the confirm dialog), by the same rule as `onPullRequestMerged`. */
export async function mergeOutcome(
  deps: Pick<GitFlowDeps, 'settings' | 'workflows'>,
  conn: Conn,
  issue: IssueV1,
  pullRequestId: string,
  autoCompleteDisabled: boolean,
): Promise<PullRequestMergeOutcome> {
  const keep = (keepReason: PullRequestMergeKeepReason) => ({
    statusKey: null,
    statusName: null,
    keepReason,
  });
  const target = (await deps.settings.read(conn)).prMergedStatus;
  const view = await deps.workflows.forIssue(conn, issue);
  if (view.isTerminal(issue.statusKey)) return keep('terminal');
  if (target === 'none') return keep('setting');
  if (autoCompleteDisabled) return keep('optedOut');
  if (!(await allLinkedMerged({ conn }, issue.id, pullRequestId)))
    return keep('otherPrs');
  const status = view.workflow.definition.statuses.find(
    (item) => item.key === target,
  );
  return {
    statusKey: target,
    statusName: status?.name ?? target,
    keepReason: null,
  };
}

export async function onPullRequestMerged(
  deps: GitFlowDeps,
  tx: Tx,
  pr: PullRequest,
): Promise<void> {
  const target = (await deps.settings.read(tx.conn)).prMergedStatus;
  const links = await linksOfPullRequest(tx.conn, pr.id);
  const issueIds: string[] = [];
  for (const link of links) {
    const issue = await findIssue(tx.conn, link.issueId);
    if (!issue) continue;
    issueIds.push(issue.id);
    const view = await deps.workflows.forIssue(tx.conn, issue);
    const details = { repo: pr.repo, number: pr.number, url: pr.url };
    let statusChangedTo: string | null = null;
    if (
      !view.isTerminal(issue.statusKey) &&
      target !== 'none' &&
      (await allLinkedMerged(tx, issue.id))
    ) {
      const after = await deps.issues().systemSetStatus(tx, issue.id, target, {
        reason: 'prMerged',
        ...details,
      });
      statusChangedTo = after ? after.statusKey : null;
    }
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor: SYSTEM_ACTOR,
      action: 'pr_merged',
      details: { ...details, pullRequestId: pr.id, statusChangedTo },
    });
    tx.emit({ type: 'issue.changed', issueId: issue.id });
    tx.emit({
      type: 'pr.merged',
      issueId: issue.id,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      statusChangedTo,
    });
  }
  if (issueIds.length > 0)
    tx.emit({ type: 'pr.closed', issueIds, merged: true });
}

export async function onPullRequestClosed(
  tx: Tx,
  pr: PullRequest,
): Promise<void> {
  const links = await linksOfPullRequest(tx.conn, pr.id);
  const issueIds = unique(links.map((link) => link.issueId));
  for (const issueId of issueIds) tx.emit({ type: 'issue.changed', issueId });
  if (issueIds.length > 0)
    tx.emit({ type: 'pr.closed', issueIds, merged: false });
}

/** Asks the owners of agent-executed issues to review a ready pull request. */
export async function requestReviews(
  tx: Tx,
  pr: PullRequest,
  issueIds: readonly string[],
): Promise<void> {
  if (pr.state !== 'open' || pr.draft) return;
  const issues = await issuesByIds(tx.conn, issueIds);
  for (const issue of issues.values()) {
    if (issue.executorType !== 'agent' || !issue.ownerUserId) continue;
    tx.emit({
      type: 'pr.reviewRequested',
      issueId: issue.id,
      pullRequestId: pr.id,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
    });
  }
}
