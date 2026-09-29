import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, queryInt, queryText, sessionActor } from '../shared/http.js';
import type { RunTokenEnv } from '../run/agent-api.routes.js';
import type { PmService } from './pm.service.js';

/**
 * `/np/pm` (browser, iteration-4 contract §C): `GET /conversation` (404 when the caller has none) and
 * `POST /conversation` (finds or creates) → `{ data: PmConversationResponse }`; 409 `PM_NOT_CONFIGURED` without a
 * usable project manager agent.
 */
export function createPmRoutes(pm: PmService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/conversation', async (context) =>
    context.json({ data: await pm.conversation(sessionActor(context), false) }),
  );
  routes.post('/conversation', async (context) =>
    context.json({ data: await pm.conversation(sessionActor(context), true) }),
  );
  return routes;
}

/**
 * `/np/agent/pm/*` (run token; requires `workspace.read`, 403 `CAPABILITY_DENIED`; everything filtered by what the
 * run's asking member may see):
 *
 * - `GET /pm/projects` → `{ data: ProjectListItem[] }`
 * - `GET /pm/issues?projectId&statusKey&ownerUserId(=me)&executorId&q&updatedSince&limit&cursor` → `{ data, nextCursor }`
 * - `GET /pm/issues/:idOrIdentifier` → `{ data: PmIssueDetail }`
 * - `GET /pm/inbox?kind=decision` → `{ data, unread, nextCursor }` (unresolved items of the asking member)
 * - `GET /pm/metrics?from&to&projectId` → `{ data: MetricsReport }`
 * - `GET /pm/knowledge?projectId&q` → `{ data: KnowledgeDocSummary[] }`
 */
export function createAgentPmRoutes(pm: PmService): Hono<RunTokenEnv> {
  const routes = npRouter<RunTokenEnv>();
  routes.get('/pm/projects', async (context) =>
    context.json({ data: await pm.projects(context.get('runAuth')) }),
  );
  routes.get('/pm/issues', async (context) =>
    context.json(
      await pm.issues(context.get('runAuth'), {
        projectId: queryText(context, 'projectId'),
        statusKey: queryText(context, 'statusKey'),
        ownerUserId: queryText(context, 'ownerUserId'),
        executorId: queryText(context, 'executorId'),
        q: queryText(context, 'q'),
        updatedSince: queryText(context, 'updatedSince'),
        limit: queryInt(context, 'limit'),
        cursor: queryText(context, 'cursor'),
      }),
    ),
  );
  routes.get('/pm/issues/:id', async (context) =>
    context.json({
      data: await pm.issue(context.get('runAuth'), context.req.param('id')),
    }),
  );
  routes.get('/pm/inbox', async (context) =>
    context.json(
      await pm.inbox(context.get('runAuth'), queryText(context, 'kind')),
    ),
  );
  routes.get('/pm/metrics', async (context) =>
    context.json({
      data: await pm.metrics(context.get('runAuth'), {
        from: queryText(context, 'from'),
        to: queryText(context, 'to'),
        projectId: queryText(context, 'projectId'),
      }),
    }),
  );
  routes.get('/pm/knowledge', async (context) =>
    context.json({
      data: await pm.knowledge(context.get('runAuth'), {
        projectId: queryText(context, 'projectId'),
        q: queryText(context, 'q'),
      }),
    }),
  );
  return routes;
}
