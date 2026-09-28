/**
 * Iteration 2 read-model pieces for issues (docs/phase1/iteration-2-contract.md §C, §D, §I, §J, §K): the extra
 * detail sections, the queued run shown in session mode, and the agent read scope.
 */
import type { ApprovalGateway } from '../shared/approval.js';
import type { Conn } from '../shared/db.js';
import { str } from '../shared/db.js';
import { notFound } from '../shared/errors.js';
import type {
  ApprovalRequest,
  IssuePullRequestView,
  IssueV4,
  QueuedRunRef,
  UsageRow,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import type { SettingsService } from '../system/settings.service.js';
import { pullRequestsForIssue } from '../git/git.records.js';
import type { RunAuth } from '../run/token.js';
import { usageForIssue } from '../usage/usage.service.js';
import { findIssue } from './issue.records.js';

/** The run waiting for the current turn to end (queued or deferred, oldest first), with its trigger count. */
export async function queuedRunOf(
  conn: Conn,
  issueId: string,
): Promise<QueuedRunRef | null> {
  const run = await conn.query
    .selectFrom('runs')
    .select('id')
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', issueId)
    .where('status', 'in', ['queued', 'deferred'])
    .orderBy('createdAt', 'asc')
    .executeTakeFirst();
  if (!run) return null;
  const triggers = await conn.query
    .selectFrom('runTriggers')
    .select('id')
    .where('runId', '=', run.id)
    .execute();
  return { id: str(run.id) ?? '', triggerCount: triggers.length };
}

export interface DetailExtras {
  readonly pullRequests: IssuePullRequestView[];
  readonly approvals: ApprovalRequest[];
  readonly usage: UsageRow;
  readonly queuedRun: QueuedRunRef | null;
}

export async function detailExtras(
  deps: {
    readonly users: UserDirectory;
    readonly settings: SettingsService;
    readonly approvals: () => ApprovalGateway;
  },
  conn: Conn,
  issue: IssueV4,
  viewerCanMerge = false,
): Promise<DetailExtras> {
  const { modelPrices } = await deps.settings.read(conn);
  const usage = await usageForIssue(conn, issue.id, modelPrices);
  return {
    pullRequests: await pullRequestsForIssue(
      conn,
      deps.users,
      issue.id,
      viewerCanMerge,
    ),
    approvals: await deps.approvals().listForIssue(issue.id),
    usage: { ...usage, name: issue.identifier },
    queuedRun: await queuedRunOf(conn, issue.id),
  };
}

/**
 * The issue an agent may read (iteration-2 §K): one in its run issue's project, or one without a project (those are
 * visible to every member). Anything else is 404, like a missing issue. Iteration 4: a project manager conversation is
 * readable only by the runs on it.
 */
export async function agentReadableIssue(
  conn: Conn,
  auth: RunAuth,
  idOrKey: string,
): Promise<IssueV4> {
  const target = await findIssue(conn, idOrKey);
  if (!target) throw notFound('Issue');
  if (target.id === auth.issueId) return target;
  if (target.originType === 'pm') throw notFound('Issue');
  if (target.projectId === null) return target;
  const own = await findIssue(conn, auth.issueId);
  if ((own?.projectId ?? null) !== target.projectId) throw notFound('Issue');
  return target;
}
