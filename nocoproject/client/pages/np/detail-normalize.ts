import { DEFAULT_STATUS_CATALOG } from './constants.js';
import type {
  ApprovalRequest,
  CommentThread,
  ExecutorProposal,
  Issue,
  IssueActivity,
  IssueComment,
  IssueDependency,
  IssueDetail,
  IssuePullRequestView,
  IssueRef,
  IssueSubscriber,
  Label,
  QueuedRun,
  RunSummary,
  StatusCatalogEntry,
  SubtaskSummary,
  UsageRow,
} from './types.js';

/**
 * The raw body of `GET /np/issues/:id`. Protocol §3 says "issue + comments(tree) + activities + runs(summary) +
 * statusCatalog" without fixing whether the issue fields sit at the top level or under `issue`, nor whether the tree
 * is nested (`replies` / `children`) or a flat list with `parentId`. Both shapes are accepted.
 */
export interface RawIssueDetail extends Partial<Issue> {
  readonly issue?: Issue;
  readonly comments?: readonly IssueComment[];
  readonly activities?: readonly IssueActivity[];
  readonly runs?: readonly RunSummary[];
  readonly statusCatalog?: readonly StatusCatalogEntry[];
  readonly subtasks?: readonly SubtaskSummary[];
  readonly blockedBy?: readonly IssueDependency[];
  readonly blocks?: readonly IssueDependency[];
  readonly proposals?: readonly ExecutorProposal[];
  readonly subscribers?: readonly IssueSubscriber[];
  readonly labels?: readonly Label[];
  readonly parent?: IssueRef | null;
  readonly project?: { readonly id: string; readonly name: string } | null;
  readonly pullRequests?: readonly IssuePullRequestView[];
  readonly approvals?: readonly ApprovalRequest[];
  readonly queuedRun?: QueuedRun | null;
  readonly usage?: UsageRow | null;
  /** Iteration 3 §D: the detail carries the newest 50 activities; older ones page from this cursor. */
  readonly activitiesNextCursor?: string | null;
}

function byCreatedAt(
  a: { readonly createdAt: string },
  b: { readonly createdAt: string },
): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** Flattens a nested or flat comment list into every comment exactly once. */
function flattenComments(comments: readonly IssueComment[]): IssueComment[] {
  const seen = new Map<string, IssueComment>();
  const visit = (comment: IssueComment, parentId: string | null): void => {
    if (!seen.has(comment.id)) {
      seen.set(comment.id, {
        ...comment,
        parentId: comment.parentId ?? parentId,
      });
    }
    for (const child of [
      ...(comment.replies ?? []),
      ...(comment.children ?? []),
    ]) {
      visit(child, comment.id);
    }
  };
  for (const comment of comments) visit(comment, null);
  return [...seen.values()];
}

/**
 * Groups comments into threads: each top-level comment with all of its descendants flattened, oldest first. A
 * reply whose ancestor chain is broken (a parent missing from the payload) becomes a thread of its own rather than
 * disappearing.
 */
export function normalizeComments(
  comments: readonly IssueComment[],
): CommentThread[] {
  const flat = flattenComments(comments);
  const byId = new Map(flat.map((comment) => [comment.id, comment]));
  const rootOf = (comment: IssueComment): IssueComment => {
    let current = comment;
    const visited = new Set<string>();
    while (current.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, IssueComment[]>();
  const roots = new Map<string, IssueComment>();
  for (const comment of flat) {
    const root = rootOf(comment);
    roots.set(root.id, root);
    if (root.id !== comment.id) {
      threads.set(root.id, [...(threads.get(root.id) ?? []), comment]);
    }
  }
  return [...roots.values()].sort(byCreatedAt).map((root) => ({
    root: { ...root, replies: undefined, children: undefined },
    replies: (threads.get(root.id) ?? [])
      .map((reply) => ({ ...reply, replies: undefined, children: undefined }))
      .sort(byCreatedAt),
  }));
}

export function normalizeIssueDetail(raw: RawIssueDetail): IssueDetail {
  const issue = (raw.issue ?? raw) as Issue;
  return {
    // Iteration 1 additions (§D) sit beside `issue`; labels may also arrive on the issue row itself.
    subtasks: raw.subtasks ?? [],
    blockedBy: raw.blockedBy ?? [],
    blocks: raw.blocks ?? [],
    proposals: raw.proposals ?? [],
    subscribers: raw.subscribers ?? [],
    labels: raw.labels ?? issue.labels ?? [],
    parent: raw.parent ?? null,
    project: raw.project ?? null,
    // Iteration 2 additions (§C, §D, §I, §J).
    pullRequests: raw.pullRequests ?? [],
    approvals: raw.approvals ?? [],
    queuedRun: raw.queuedRun ?? null,
    usage: raw.usage ?? null,
    activitiesNextCursor:
      typeof raw.activitiesNextCursor === 'string' && raw.activitiesNextCursor
        ? raw.activitiesNextCursor
        : null,
    issue,
    threads: normalizeComments(raw.comments ?? []),
    activities: [...(raw.activities ?? [])].sort(byCreatedAt),
    runs: [...(raw.runs ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
    statusCatalog:
      raw.statusCatalog && raw.statusCatalog.length > 0
        ? raw.statusCatalog
        : DEFAULT_STATUS_CATALOG,
  };
}

/** The trigger type a run summary carries, from `triggerType` or its first trigger. */
export function runTriggerType(run: RunSummary): string | null {
  return run.triggerType ?? run.triggers?.[0]?.type ?? null;
}

/**
 * The detail with a just-posted comment in its thread, so the comment shows before the refetch returns. A comment
 * the detail already holds is left as it is.
 */
export function withComment(
  detail: IssueDetail,
  comment: IssueComment,
): IssueDetail {
  const comments = detail.threads.flatMap((thread) => [
    thread.root,
    ...thread.replies,
  ]);
  if (comments.some((existing) => existing.id === comment.id)) return detail;
  return { ...detail, threads: normalizeComments([...comments, comment]) };
}

/** How often to poll a detail whose run is waiting to start or working, so no realtime signal is needed. */
export const DETAIL_POLL_MS = 5_000;
const POLLED_RUN_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'dispatched',
  'running',
]);

/**
 * The detail's refetch interval: while a run is queued, dispatched or running, the detail polls, so the agent
 * picking the work up and finishing it show even when the realtime connection has silently dropped. Deferred runs
 * wait on something else and do not poll.
 */
export function detailRefetchInterval(
  detail: IssueDetail | undefined,
): number | false {
  const active =
    detail?.runs.some((run) => POLLED_RUN_STATUSES.has(run.status)) ?? false;
  return active ? DETAIL_POLL_MS : false;
}
