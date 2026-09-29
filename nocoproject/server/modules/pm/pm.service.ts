import { canInvokeAgent, loadAgentAccess } from '../shared/authz.js';
import { hasCapability, requireCapability } from '../agent/capabilities.js';
/**
 * The project manager agent (docs/phase1/iteration-4-contract.md §C).
 *
 * Conversation: `POST /np/pm/conversation` finds — or creates — the calling member's conversation, `GET` only finds
 * it (404 when there is none): an issue without a project (title "项目经理 · <name>", `executionMode = 'session'`,
 * executor = `settings.pmAgentId`, owner = the member, `originType = 'pm'`, process direct), private to its owner
 * (`shared/authz.ts`). Creating one starts no run: the member's comments do. When `pmAgentId` changed, the
 * conversation's executor follows it. With no usable project manager (unset, missing, archived or not a manager) both
 * answer 409 `PM_NOT_CONFIGURED`. Creation is serialized per member with an advisory lock (PostgreSQL).
 *
 * Reads for the agent (`/np/agent/pm/*`, run token): requires the explicit `workspace.read` capability; every
 * read goes through the browser services as the run's asking member (`actorUserId`), so it sees exactly what that
 * member may see (403 `FORBIDDEN` when the run has none).
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import { viewerOf } from '../shared/authz.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { isPostgres, knexOf, now } from '../shared/db.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import type {
  InboxUnreadCounts,
  InboxItemV4,
  IssueListPageV3,
  IssueV4,
  KnowledgeDocSummary,
  MetricsReport,
  PmConversationResponse,
  PmIssueDetailV4,
  ProjectListItem,
} from '../shared/protocol.js';
import { PM_DETAIL_TAIL } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import type { SettingsService } from '../system/settings.service.js';
import type { IssueQueries } from '../issue/issue.queries.js';
import type { IssueService } from '../issue/issue.service.js';
import { mapIssue } from '../issue/issue.records.js';
import type { KnowledgeService } from '../knowledge/knowledge.service.js';
import type {
  MetricsQuery,
  MetricsService,
} from '../metrics/metrics.service.js';
import type { InboxService } from '../notification/inbox.service.js';
import type { ProjectService } from '../project/project.service.js';
import type { RunAuth } from '../run/token.js';

export interface PmIssueQuery {
  readonly projectId?: string | null;
  readonly statusKey?: string | null;
  readonly ownerUserId?: string | null;
  readonly executorId?: string | null;
  readonly q?: string | null;
  readonly updatedSince?: string | null;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export interface PmInboxPage {
  readonly data: readonly InboxItemV4[];
  readonly unread: InboxUnreadCounts;
  readonly nextCursor: string | null;
}

export interface PmService {
  /** `create: false` = GET (404 when the member has none). */
  conversation(actor: Actor, create: boolean): Promise<PmConversationResponse>;
  projects(auth: RunAuth): Promise<ProjectListItem[]>;
  issues(auth: RunAuth, query: PmIssueQuery): Promise<IssueListPageV3>;
  issue(auth: RunAuth, idOrKey: string): Promise<PmIssueDetailV4>;
  inbox(auth: RunAuth, kind: string | null): Promise<PmInboxPage>;
  metrics(auth: RunAuth, query: MetricsQuery): Promise<MetricsReport>;
  knowledge(
    auth: RunAuth,
    query: { projectId?: string | null; q?: string | null },
  ): Promise<KnowledgeDocSummary[]>;
}

export interface PmDeps {
  readonly tx: TxRunner;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly settings: SettingsService;
  readonly issues: () => IssueService;
  readonly queries: () => IssueQueries;
  readonly projects: () => ProjectService;
  readonly inbox: () => InboxService;
  readonly metrics: () => MetricsService;
  readonly knowledge: () => KnowledgeService;
}

const RELATIVE_SINCE = /^(\d{1,5})([dhm])$/u;
const UNIT_MS: Readonly<Record<string, number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
};

async function isConversationAgent(
  tx: Tx,
  agentId: string | null,
): Promise<boolean> {
  if (!agentId) return false;
  const row = await tx.conn.query
    .selectFrom('agents')
    .select(['archivedAt'])
    .where('id', '=', agentId)
    .executeTakeFirst();
  return (
    !!row &&
    !row.archivedAt &&
    (await hasCapability(tx.conn, agentId, 'comment.create'))
  );
}

async function lockMember(tx: Tx, userId: string): Promise<void> {
  if (!isPostgres(tx.conn)) return;
  const knex = await knexOf(tx.conn);
  await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
    `nocoproject:pm:${userId}`,
  ]);
}

/** Points an existing conversation at the current project manager (no run starts). */
async function followManager(
  deps: PmDeps,
  tx: Tx,
  issue: IssueV4,
  agentId: string,
): Promise<void> {
  const timestamp = now();
  await tx.conn.query
    .updateTable('issues')
    .set({
      executorType: 'agent',
      executorId: agentId,
      revision: issue.revision + 1,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    })
    .where('id', '=', issue.id)
    .execute();
  await deps.activity.record(tx.conn, {
    issueId: issue.id,
    actor: { type: 'system', id: null },
    action: 'executor_changed',
    details: {
      from: { type: issue.executorType, id: issue.executorId },
      to: { type: 'agent', id: agentId },
      reason: 'pmAgentChanged',
    },
  });
  tx.emit({ type: 'issue.changed', issueId: issue.id });
}

async function conversation(
  deps: PmDeps,
  actor: Actor,
  create: boolean,
): Promise<PmConversationResponse> {
  const userId = (await viewerOf(deps.tx.read(), actor)).userId;
  return deps.tx.run(async (tx) => {
    await lockMember(tx, userId);
    const { agentEntries } = await deps.settings.read(tx.conn);
    const pmAgentId = agentEntries.conversation.enabled
      ? agentEntries.conversation.agentId
      : null;
    const usable = (await isConversationAgent(tx, pmAgentId))
      ? pmAgentId
      : null;
    if (!usable)
      throw conflict(
        'PM_NOT_CONFIGURED',
        'No project manager agent is configured (settings.pmAgentId must name an active manager agent).',
      );
    const target = await loadAgentAccess(tx.conn, usable);
    if (!target || !(await canInvokeAgent(tx.conn, userId, target)))
      throw forbidden('FORBIDDEN', 'You cannot invoke the configured agent.');
    const row = await tx.conn.query
      .selectFrom('issues')
      .selectAll()
      .where('originType', '=', 'pm')
      .where('ownerUserId', '=', userId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .executeTakeFirst();
    if (row) {
      const existing = mapIssue(row);
      if (existing.executorId !== usable)
        await followManager(deps, tx, existing, usable);
      return {
        issueId: existing.id,
        identifier: existing.identifier,
        agentId: usable,
      };
    }
    if (!create) throw notFound('Project manager conversation');
    const name = (await deps.users.names(tx.conn, [userId])).get(userId);
    const created = await deps.issues().insertIssue(tx, actor, {
      title: `${agentEntries.conversation.name} · ${name ?? userId}`,
      description: '',
      statusKey: 'todo',
      priority: 'none',
      ownerUserId: userId,
      executor: { executorType: 'agent', executorId: usable },
      parentIssueId: null,
      projectId: null,
      stage: null,
      startDate: null,
      dueDate: null,
      autoExecuteSubtasks: false,
      labelIds: [],
      createdById: userId,
      executionMode: 'session',
      originType: 'pm',
      originId: null,
      process: 'direct',
    });
    return {
      issueId: created.id,
      identifier: created.identifier,
      agentId: usable,
    };
  });
}

/** The asking member of a manager's run (see the file comment). */
async function askingMember(deps: PmDeps, auth: RunAuth): Promise<Actor> {
  await requireCapability(deps.tx.read(), auth, 'workspace.read');
  if (!auth.actorUserId)
    throw forbidden('FORBIDDEN', 'This run has no asking member.');
  return { type: 'user', id: auth.actorUserId };
}

/** `updatedSince`: an ISO timestamp, or `7d` / `24h` / `30m` before now. */
export function parseSince(value: string | null | undefined): Date | null {
  if (!value) return null;
  const relative = RELATIVE_SINCE.exec(value);
  if (relative)
    return new Date(
      Date.now() - Number(relative[1]) * (UNIT_MS[relative[2] ?? 'd'] ?? 0),
    );
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw invalid(
      'INVALID_QUERY',
      'updatedSince must be an ISO timestamp or a duration such as 7d, 24h or 30m.',
    );
  return date;
}

async function pmIssue(
  deps: PmDeps,
  auth: RunAuth,
  idOrKey: string,
): Promise<PmIssueDetailV4> {
  const actor = await askingMember(deps, auth);
  const detail = await deps.queries().detail(actor, idOrKey);
  return {
    issue: detail.issue,
    comments: detail.comments.slice(-PM_DETAIL_TAIL),
    activities: detail.activities.slice(-PM_DETAIL_TAIL),
    runs: detail.runs,
    pullRequests: detail.pullRequests,
    subtasks: detail.subtasks,
    usage: detail.usage,
  };
}

export function createPmService(deps: PmDeps): PmService {
  const asking = (auth: RunAuth) => askingMember(deps, auth);
  return {
    conversation: (actor, create) => conversation(deps, actor, create),
    projects: async (auth) => deps.projects().list(await asking(auth)),
    async issues(auth, query) {
      const actor = await asking(auth);
      return deps.queries().page(
        actor,
        {
          projectId: query.projectId,
          statusKey: query.statusKey,
          ownerUserId:
            query.ownerUserId === 'me' ? actor.id : query.ownerUserId,
          executorId: query.executorId,
          q: query.q,
          updatedSince: parseSince(query.updatedSince),
        },
        { cursor: query.cursor, limit: query.limit },
      );
    },
    issue: (auth, idOrKey) => pmIssue(deps, auth, idOrKey),
    async inbox(auth, kind) {
      return deps.inbox().list(await asking(auth), {
        kind: kind ?? 'decision',
        resolved: 'false',
      });
    },
    metrics: async (auth, query) =>
      deps.metrics().report(await asking(auth), query),
    knowledge: async (auth, query) =>
      deps.knowledge().list(await asking(auth), query),
  };
}
