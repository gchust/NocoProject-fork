import { requireCapability } from '../agent/capabilities.js';
/**
 * Read models over issues: browser list, board and detail (filtered by what the caller may see), and the views an
 * agent sees through its run token. Iteration 3: the list and board page by cursor (`issue.list.ts`); the detail
 * carries the latest 50 activities and at most the latest 200 comments, with cursors for older ones
 * (`issue.timeline.ts`, `CommentService.pageForIssue`). Iteration 4: rows carry `process`, `designApprovedAt`,
 * `designApprovedById`; the detail's `issue.designProposal` is the latest proposal; the agent view adds `process` and
 * `designApprovedAt`.
 */
import type { Actor } from '../shared/activity.js';
import type { ApprovalGateway } from '../shared/approval.js';
import {
  canMergePullRequest,
  requireVisibleIssue,
  viewerOf,
} from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { str } from '../shared/db.js';
import { notFound } from '../shared/errors.js';
import { pageLimit } from '../shared/pagination.js';
import type { RuntimeType } from '../shared/protocol.js';
import type {
  ActivityPage,
  AgentContextResponseV1,
  BoardGroupV3Server,
  CommentPage,
  IssueDetailV5Paged,
  IssueForAgentV4,
  IssueListItemV2,
  IssueListPageV3,
  IssueRunsResponse,
  IssueSubscriber,
  IssueV4,
  SubscriptionReason,
  SubtaskSummary,
} from '../shared/protocol.js';
import {
  ACTIVITY_PAGE_DEFAULT_LIMIT,
  ACTIVITY_PAGE_MAX_LIMIT,
  DETAIL_COMMENTS_LIMIT,
} from '../shared/protocol.js';
import type { SettingsService } from '../system/settings.service.js';
import type { UserDirectory } from '../shared/users.js';
import type { CommentService } from '../collaboration/comment.service.js';
import { agentAttachments } from '../attachment/attachment.records.js';
import { claimedPullRequests } from '../git/git.records.js';
import { claimedProject } from '../project/project.records.js';
import { agentNames, runSummariesForIssue } from '../run/run.queries.js';
import type { RunAuth } from '../run/token.js';
import { blockersOf, childrenOf } from '../subtask/blocking.js';
import { dependenciesOf } from '../subtask/dependency.service.js';
import { proposalsFor } from '../subtask/proposal.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import {
  agentReadableIssue,
  detailExtras,
  queuedRunOf,
} from './issue.extras.js';
import {
  issueBoard,
  issueList,
  issuePage,
  withNames,
  type BoardOptions,
  type IssueListFilter,
  type IssuePageOptions,
} from './issue.list.js';
import { findIssue, issueRef } from './issue.records.js';
import { latestProposal } from './process.js';
import { activityPage } from './issue.timeline.js';

export interface IssueQueries {
  /** Up to 500 issues in list order (internal callers; the browser uses `page`). */
  list(actor: Actor, filter: IssueListFilter): Promise<IssueListItemV2[]>;
  /** `GET /np/issues` (iteration 3 §D): one keyset page. */
  page(
    actor: Actor,
    filter: IssueListFilter,
    options: IssuePageOptions,
  ): Promise<IssueListPageV3>;
  /** `GET /np/issues?view=board`: a page per column, or one column with `statusKey`. */
  board(
    actor: Actor,
    filter: IssueListFilter,
    options?: BoardOptions,
  ): Promise<{ groups: BoardGroupV3Server[] }>;
  detail(actor: Actor, idOrKey: string): Promise<IssueDetailV5Paged>;
  /** `GET /np/issues/:id/activities`. */
  activities(
    actor: Actor,
    idOrKey: string,
    options: TimelineOptions,
  ): Promise<ActivityPage>;
  /** `GET /np/issues/:id/comments`. */
  comments(
    actor: Actor,
    idOrKey: string,
    options: TimelineOptions,
  ): Promise<CommentPage>;
  /** `GET /np/issues/:id/runs`: the issue's runs and the run queued behind the current turn. */
  runs(
    actor: Actor,
    idOrKey: string,
    runtimeType?: RuntimeType | null,
  ): Promise<IssueRunsResponse>;
  /** Any issue, unscoped (the caller already checked the run's scope). */
  forAgent(idOrKey: string): Promise<IssueForAgentV4>;
  /** An issue the run may read (iteration 2 §K: same project, or no project), else 404. */
  forAgentScoped(auth: RunAuth, idOrKey: string): Promise<IssueForAgentV4>;
  agentReadable(auth: RunAuth, idOrKey: string): Promise<IssueV4>;
  agentContext(auth: RunAuth): Promise<AgentContextResponseV1>;
  children(idOrKey: string): Promise<SubtaskSummary[]>;
}

export interface IssueQueryDeps {
  readonly tx: TxRunner;
  readonly users: UserDirectory;
  readonly workflows: WorkflowService;
  readonly settings: SettingsService;
  readonly comments: () => CommentService;
  readonly approvals: () => ApprovalGateway;
}

const LIST_LIMIT = 500;

export interface TimelineOptions {
  readonly cursor?: string | null;
  readonly limit?: number | null;
}

export type { IssueListFilter, IssuePageOptions, BoardOptions };

async function subscribers(
  conn: Conn,
  users: UserDirectory,
  issueId: string,
): Promise<IssueSubscriber[]> {
  const rows = await conn.query
    .selectFrom('issueSubscribers')
    .select(['userId', 'reason'])
    .where('issueId', '=', issueId)
    .where('unsubscribedAt', 'is', null)
    .orderBy('createdAt', 'asc')
    .execute();
  const names = await users.names(
    conn,
    rows.map((row) => str(row.userId)),
  );
  return rows.map((row) => {
    const userId = str(row.userId) ?? '';
    return {
      userId,
      name: names.get(userId) ?? userId,
      reason: (str(row.reason) ?? 'manual') as SubscriptionReason,
    };
  });
}

async function summaries(
  deps: IssueQueryDeps,
  conn: Conn,
  issues: readonly IssueV4[],
): Promise<SubtaskSummary[]> {
  const items = await withNames(deps, conn, issues);
  return items.map((item) => ({
    id: item.id,
    identifier: item.identifier,
    title: item.title,
    statusKey: item.statusKey,
    stage: item.stage,
    executorType: item.executorType,
    executorName: item.executorName,
    blockedCount: item.blockedCount,
  }));
}

async function forAgent(
  deps: IssueQueryDeps,
  idOrKey: string,
  auth?: RunAuth,
): Promise<IssueForAgentV4> {
  const conn = deps.tx.read();
  const issue = auth
    ? await agentReadableIssue(conn, auth, idOrKey)
    : await findIssue(conn, idOrKey);
  if (!issue) throw notFound('Issue');
  const [item] = await withNames(deps, conn, [issue]);
  const parent = issue.parentIssueId
    ? await findIssue(conn, issue.parentIssueId)
    : null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    statusKey: issue.statusKey,
    priority: issue.priority,
    ownerName: item?.ownerName ?? '',
    executor: {
      type: issue.executorType,
      id: issue.executorId,
      name: item?.executorName ?? null,
    },
    parentIssueId: issue.parentIssueId,
    parent: parent ? issueRef(parent) : null,
    projectId: issue.projectId,
    stage: issue.stage,
    autoExecuteSubtasks: issue.autoExecuteSubtasks,
    labels: (item?.labels ?? []).map((label) => label.name),
    blockers: await blockersOf(conn, deps.workflows, issue),
    executionMode: issue.executionMode,
    pullRequests: await claimedPullRequests(conn, issue.id),
    process: issue.process,
    designApprovedAt: issue.designApprovedAt,
    attachments: await agentAttachments(conn, issue.id),
  };
}

async function issueQueryDetail(
  deps: IssueQueryDeps,
  ...[actor, idOrKey]: Parameters<IssueQueries['detail']>
): Promise<IssueDetailV5Paged> {
  const conn = deps.tx.read();
  const viewer = await viewerOf(conn, actor);
  const issue = await requireVisibleIssue(conn, viewer, idOrKey);
  const [item] = await withNames(deps, conn, [issue]);
  const view = await deps.workflows.forIssue(conn, issue);
  const parent = issue.parentIssueId
    ? await findIssue(conn, issue.parentIssueId)
    : null;
  const project = issue.projectId
    ? await conn.query
        .selectFrom('projects')
        .select(['id', 'name'])
        .where('id', '=', issue.projectId)
        .executeTakeFirst()
    : null;
  const deps2 = await dependenciesOf(conn, issue.id);
  const extras = await detailExtras(
    deps,
    conn,
    issue,
    await canMergePullRequest(conn, viewer, issue),
  );
  const activities = await activityPage(
    conn,
    deps.users,
    issue.id,
    null,
    ACTIVITY_PAGE_DEFAULT_LIMIT,
  );
  const comments = await deps
    .comments()
    .pageForIssue(conn, issue.id, null, DETAIL_COMMENTS_LIMIT);
  return {
    issue: {
      ...item,
      designProposal: await latestProposal(conn, issue.id),
    },
    comments: comments.data,
    commentsNextCursor: comments.nextCursor,
    activities: activities.data,
    activitiesNextCursor: activities.nextCursor,
    runs: await runSummariesForIssue(conn, issue.id),
    statusCatalog: view.catalog,
    agentTransitions: view.agentTransitions,
    subtasks: await summaries(deps, conn, await childrenOf(conn, issue.id)),
    blockedBy: deps2.blockedBy,
    blocks: deps2.blocks,
    blockers: await blockersOf(conn, deps.workflows, issue),
    proposals: await proposalsFor(conn, issue.id),
    subscribers: await subscribers(conn, deps.users, issue.id),
    labels: item.labels,
    parent: parent ? issueRef(parent) : null,
    project: project
      ? { id: str(project.id) ?? '', name: str(project.name) ?? '' }
      : null,
    ...extras,
  };
}

async function issueQueryRuns(
  deps: IssueQueryDeps,
  ...[actor, idOrKey, runtimeType]: Parameters<IssueQueries['runs']>
) {
  const conn = deps.tx.read();
  const issue = await requireVisibleIssue(
    conn,
    await viewerOf(conn, actor),
    idOrKey,
  );
  return {
    data: await runSummariesForIssue(conn, issue.id, runtimeType),
    queuedRun: await queuedRunOf(conn, issue.id),
  };
}

async function issueQueryAgentContext(
  deps: IssueQueryDeps,
  ...[auth]: Parameters<IssueQueries['agentContext']>
) {
  const conn = deps.tx.read();
  await requireCapability(conn, auth, 'context.read');
  const names = await agentNames(conn, [auth.agentId]);
  const issue = await forAgent(deps, auth.issueId);
  const view = await deps.workflows.forProject(conn, issue.projectId);
  return {
    run: { id: auth.runId },
    agent: { id: auth.agentId, name: names.get(auth.agentId) ?? '' },
    issue,
    statusCatalog: view.catalog,
    agentTransitions: view.agentTransitions,
    project: await claimedProject(conn, issue.projectId),
  };
}

async function issueQueryChildren(
  deps: IssueQueryDeps,
  ...[idOrKey]: Parameters<IssueQueries['children']>
) {
  const conn = deps.tx.read();
  const issue = await findIssue(conn, idOrKey);
  if (!issue) throw notFound('Issue');
  return summaries(deps, conn, await childrenOf(conn, issue.id));
}

async function visibleIssueId(
  deps: IssueQueryDeps,
  actor: Actor,
  idOrKey: string,
): Promise<string> {
  const conn = deps.tx.read();
  return (await requireVisibleIssue(conn, await viewerOf(conn, actor), idOrKey))
    .id;
}

export function createIssueQueries(deps: IssueQueryDeps): IssueQueries {
  const viewer = async (actor: Actor) => viewerOf(deps.tx.read(), actor);
  const timelineLimit = (limit: number | null | undefined) =>
    pageLimit(limit, ACTIVITY_PAGE_DEFAULT_LIMIT, ACTIVITY_PAGE_MAX_LIMIT);
  return {
    list: async (actor, filter) =>
      issueList(deps, deps.tx.read(), await viewer(actor), filter, LIST_LIMIT),
    page: async (actor, filter, options) =>
      issuePage(deps, deps.tx.read(), await viewer(actor), filter, options),
    board: async (actor, filter, options = {}) =>
      issueBoard(deps, deps.tx.read(), await viewer(actor), filter, options),
    activities: async (actor, idOrKey, options) =>
      activityPage(
        deps.tx.read(),
        deps.users,
        await visibleIssueId(deps, actor, idOrKey),
        options.cursor ?? null,
        timelineLimit(options.limit),
      ),
    comments: async (actor, idOrKey, options) =>
      deps
        .comments()
        .pageForIssue(
          deps.tx.read(),
          await visibleIssueId(deps, actor, idOrKey),
          options.cursor ?? null,
          timelineLimit(options.limit),
        ),
    forAgent: (idOrKey) => forAgent(deps, idOrKey),
    forAgentScoped: (auth, idOrKey) => forAgent(deps, idOrKey, auth),
    agentReadable: (auth, idOrKey) =>
      agentReadableIssue(deps.tx.read(), auth, idOrKey),
    runs: (...args) => issueQueryRuns(deps, ...args),
    detail: (...args) => issueQueryDetail(deps, ...args),
    agentContext: (...args) => issueQueryAgentContext(deps, ...args),
    children: (...args) => issueQueryChildren(deps, ...args),
  };
}
