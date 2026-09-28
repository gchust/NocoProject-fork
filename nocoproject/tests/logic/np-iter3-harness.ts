/**
 * Helpers shared by the iteration 3 integration tests (`np-knowledge`, `np-metrics`, `np-pagination`,
 * `np-inbox-actions`, `np-perf`): the real browser route factories behind a stand-in for `auth.required()` that
 * signs in the user named by the caller, the agent knowledge routes behind the real run-token guard, and a claimed
 * run with its token.
 */
import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { createKnowledgeRoutes } from '../../server/modules/knowledge/knowledge.routes.ts';
import { createAgentKnowledgeRoutes } from '../../server/modules/knowledge/knowledge.routes.ts';
import { createIssueRoutes } from '../../server/modules/issue/issue.routes.ts';
import { createMetricsRoutes } from '../../server/modules/metrics/metrics.routes.ts';
import { createInboxRoutes } from '../../server/modules/notification/inbox.routes.ts';
import { createProjectRoutes } from '../../server/modules/project/project.routes.ts';
import { runTokenAuth } from '../../server/modules/run/agent-api.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import { guarded, npRouter } from '../../server/modules/shared/http.ts';
import { createSettingsRoutes } from '../../server/modules/system/settings.routes.ts';
import { createWorkflowRoutes } from '../../server/modules/workflow/workflow.routes.ts';
import {
  claimOne,
  createAgent,
  registerRuntime,
  type Fixture,
  type NpTestDatabase,
} from './np-harness.ts';

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly body: T & { code?: string; message?: string };
}

export type ApiCall = <T = { data: unknown }>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<ApiResponse<T>>;

/** The browser routers of iteration 3 (and the ones they compose with), mounted at their `/np/*` prefixes. */
function browserRouter(services: NpServices, as: Actor): Hono<AuthEnv> {
  const root = npRouter<AuthEnv>();
  root.use('*', async (context, next) => {
    context.set('auth', {
      user: { id: as.id ?? '', name: as.id ?? '', email: `${as.id}@x` },
      session: {},
    } as never);
    await next();
  });
  root.route(
    '/np/issues',
    createIssueRoutes({
      issues: services.issues,
      queries: services.issueQueries,
      deliveries: services.deliveries,
      slowLog: { warn: () => undefined },
    }),
  );
  root.route('/np/knowledge', createKnowledgeRoutes(services.knowledge));
  root.route('/np/metrics', createMetricsRoutes(services.metrics));
  root.route('/np/inbox', createInboxRoutes(services.inbox));
  root.route(
    '/np/projects',
    createProjectRoutes(services.projects, services.knowledge),
  );
  root.route(
    '/np/workflows',
    createWorkflowRoutes(services.workflows, services.workflowProposals),
  );
  root.route('/np/settings', createSettingsRoutes(services.workspaceSettings));
  return root;
}

async function call<T>(
  router: { request: Hono['request'] },
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await router.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as ApiResponse<T>['body'],
  };
}

/** Calls the browser API as `as`. */
export function browserApi(services: NpServices, as: Actor): ApiCall {
  const router = browserRouter(services, as);
  return (method, path, body) => call(router, {}, method, path, body);
}

/** Calls `/np/agent/knowledge*` with a run token (paths relative to `/np/agent`). */
export function agentKnowledgeApi(
  services: NpServices,
  token: string,
): ApiCall {
  const router = guarded(
    [runTokenAuth(services.runTokens)],
    createAgentKnowledgeRoutes(services.knowledge),
  );
  return (method, path, body) =>
    call(router, { authorization: `Bearer ${token}` }, method, path, body);
}

export interface ClaimedRunFixture {
  readonly fixture: Fixture;
  readonly agentId: string;
  readonly runId: string;
  readonly token: string;
  readonly knowledge: readonly { id: string; slug: string }[];
}

/** An agent owned by `owner` executing a new issue (in `projectId`), claimed: its run id and token. */
export async function claimedRun(
  services: NpServices,
  owner: Actor,
  issueId: string,
  existing?: { fixture: Fixture; agentId: string },
): Promise<ClaimedRunFixture> {
  const fixture = existing?.fixture ?? (await registerRuntime(services, owner));
  const agentId =
    existing?.agentId ??
    (await createAgent(services, owner, fixture.runtimeId, 'Scribe'));
  const issue = await services.issueQueries.detail(owner, issueId);
  await services.issues.update(owner, issueId, {
    executor: { type: 'agent', id: agentId },
    revision: issue.issue.revision,
  });
  const claimed = await claimOne(services, owner, fixture);
  if (!claimed) throw new Error('nothing was claimed');
  return {
    fixture,
    agentId,
    runId: claimed.run.id,
    token: claimed.token,
    knowledge: (
      claimed as unknown as { knowledge: { id: string; slug: string }[] }
    ).knowledge,
  };
}

export interface IssueSeed {
  readonly count: number;
  readonly prefix?: string;
  readonly projectId?: string | null;
  readonly statusKeys?: readonly string[];
  readonly ownerUserId?: string;
  readonly parentIssueId?: string | null;
  /** Start of `updatedAt`; each issue is `stepMs` older than the previous one. */
  readonly start?: Date;
  readonly stepMs?: number;
  /** Every n-th issue repeats the previous timestamp (tie-break by id). */
  readonly tieEvery?: number;
}

/**
 * Bulk-inserts issues straight into the table (fixtures for pagination and performance). Timestamps have
 * millisecond precision, like the application's. Returns their ids in insertion order.
 */
export async function insertIssues(
  db: NpTestDatabase,
  seed: IssueSeed,
): Promise<string[]> {
  const counter = (await db.knex.raw(
    `UPDATE "${db.schema}".system_settings SET issue_counter = issue_counter + ? WHERE id = 'default'
     RETURNING issue_counter`,
    [seed.count],
  )) as { rows: { issue_counter: number }[] };
  const last = Number(counter.rows[0]?.issue_counter ?? seed.count);
  const first = last - seed.count + 1;
  const start = (seed.start ?? new Date('2026-09-20T12:00:00.000Z')).getTime();
  const step = seed.stepMs ?? 1000;
  const statuses = seed.statusKeys ?? ['todo'];
  const ids: string[] = [];
  const records: Record<string, unknown>[] = [];
  let at = start;
  for (let index = 0; index < seed.count; index += 1) {
    if (!(seed.tieEvery && index % seed.tieEvery === 1)) at -= step;
    const number = first + index;
    const id = `${seed.prefix ?? 'is'}-${String(number).padStart(6, '0')}`;
    ids.push(id);
    const stamp = new Date(at);
    records.push({
      id,
      number,
      identifier: `NP-${number}`,
      title: `Issue ${number}`,
      description: '',
      status_key: statuses[index % statuses.length],
      priority: 'none',
      owner_user_id: seed.ownerUserId ?? 'u-alice',
      executor_type: 'none',
      executor_id: null,
      parent_issue_id: seed.parentIssueId ?? null,
      project_id: seed.projectId ?? null,
      revision: 1,
      last_activity_at: stamp,
      created_by_id: seed.ownerUserId ?? 'u-alice',
      created_at: stamp,
      updated_at: stamp,
      auto_execute_subtasks: false,
      execution_mode: 'task',
      origin_type: 'manual',
    });
  }
  for (let index = 0; index < records.length; index += 500)
    await db.knex
      .withSchema(db.schema)
      .table('issues')
      .insert(records.slice(index, index + 500));
  return ids;
}
