import { requireCapability } from '../agent/capabilities.js';
/**
 * The project manager's reads (docs/phase1/iteration-4-contract.md §C; NP-183 protocol-pm-assistant.md §2.3, §7).
 * Conversations live in `pm.conversations.ts`, direct writes in `pm-act.service.ts`, the roster in `pm.roster.ts`.
 *
 * Reads for the agent (`/np/agent/pm/*`, run token): requires the explicit `workspace.read` capability; every read
 * goes through the browser services as the run's asking member (`actorUserId`) with that member's own access
 * (`memberAccessOf`), so it sees exactly what they see in the browser (403 `FORBIDDEN` when the run has none, 403
 * `ASKER_UNAVAILABLE` when the member can no longer act).
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import { memberAccessOf } from '../shared/authz.js';
import type { RoleAssignments } from '../member/member.roles.js';
import type { TxRunner } from '../shared/db.js';
import { forbidden, invalid } from '../shared/errors.js';
import type {
  InboxUnreadCounts,
  InboxItemV4,
  IssueListPageV3,
  KnowledgeDocSummary,
  MetricsReport,
  PmIssueDetailV4,
  ProjectListItem,
} from '../shared/protocol.js';
import {
  PM_DETAIL_TAIL,
  type PmConversationResponse,
  PM_RUN_EVENTS_MAX,
  type PmRosterAgent,
  type RunEventsResponse,
} from '../shared/protocol.js';
import type { RunEventService } from '../run/run-events.js';
import type { RunQueries } from '../run/run.queries.js';
import { roster } from './pm.roster.js';
import type { ConversationService } from './pm.conversations.js';
import type { UserDirectory } from '../shared/users.js';
import type { SettingsService } from '../system/settings.service.js';
import type { IssueQueries } from '../issue/issue.queries.js';
import type { IssueService } from '../issue/issue.service.js';
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
  /** The iteration-4 single conversation: the latest unarchived one, created when `create` (`pm.conversations.ts`). */
  conversation(actor: Actor, create: boolean): Promise<PmConversationResponse>;
  /** The run's asking member with their own access (NP-183), for the other project manager services. */
  asker(auth: RunAuth): Promise<Actor>;
  projects(auth: RunAuth): Promise<ProjectListItem[]>;
  issues(auth: RunAuth, query: PmIssueQuery): Promise<IssueListPageV3>;
  issue(auth: RunAuth, idOrKey: string): Promise<PmIssueDetailV4>;
  inbox(auth: RunAuth, kind: string | null): Promise<PmInboxPage>;
  metrics(auth: RunAuth, query: MetricsQuery): Promise<MetricsReport>;
  knowledge(
    auth: RunAuth,
    query: { projectId?: string | null; q?: string | null },
  ): Promise<KnowledgeDocSummary[]>;
  /** NP-183 (§7.1): the executor roster, an issue's runs and pull requests, a run's latest events. */
  agents(auth: RunAuth): Promise<PmRosterAgent[]>;
  runs(auth: RunAuth, issueId: string): Promise<PmIssueDetailV4['runs']>;
  runEvents(
    auth: RunAuth,
    runId: string,
    limit: number | null,
  ): Promise<RunEventsResponse>;
  pullRequests(
    auth: RunAuth,
    issueId: string,
  ): Promise<PmIssueDetailV4['pullRequests']>;
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
  readonly roles: () => RoleAssignments;
  readonly runQueries: () => RunQueries;
  readonly runEvents: () => RunEventService;
  readonly conversations: () => Pick<ConversationService, 'legacy'>;
}

const RELATIVE_SINCE = /^(\d{1,5})([dhm])$/u;
const UNIT_MS: Readonly<Record<string, number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
};

/**
 * The asking member of a manager's run (see the file comment), carrying their own access (NP-183: what a browser
 * request of theirs would see, never a narrower "related" fallback; 403 `ASKER_UNAVAILABLE` without one).
 */
async function askingMember(deps: PmDeps, auth: RunAuth): Promise<Actor> {
  const conn = deps.tx.read();
  await requireCapability(conn, auth, 'workspace.read');
  if (!auth.actorUserId)
    throw forbidden('FORBIDDEN', 'This run has no asking member.');
  return {
    type: 'user',
    id: auth.actorUserId,
    access: await memberAccessOf(conn, deps.roles(), auth.actorUserId),
  };
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
    asker: asking,
    conversation: (actor, create) => deps.conversations().legacy(actor, create),
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
    async agents(auth) {
      const actor = await asking(auth);
      return roster(deps.tx.read(), actor.id ?? '');
    },
    runs: async (auth, issueId) =>
      (await deps.queries().detail(await asking(auth), issueId)).runs,
    async runEvents(auth, runId, limit) {
      await deps.runQueries().assertVisible(await asking(auth), runId);
      const events = await deps.runEvents().list(runId, null);
      const tail = Math.min(
        Math.max(limit ?? PM_RUN_EVENTS_MAX, 1),
        PM_RUN_EVENTS_MAX,
      );
      return { ...events, data: events.data.slice(-tail) };
    },
    pullRequests: async (auth, issueId) =>
      (await deps.queries().detail(await asking(auth), issueId)).pullRequests,
  };
}
