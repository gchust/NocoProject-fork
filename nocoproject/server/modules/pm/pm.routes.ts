import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import {
  npRouter,
  queryInt,
  queryText,
  readJson,
  sessionActor,
} from '../shared/http.js';
import type {
  PmAgentChoiceRequest,
  PmAgentCopyRequest,
  PmConversationCreateRequest,
  PmConversationPatch,
} from '../shared/protocol.js';
import type { PmAgentService } from './pm-agent.service.js';
import type { ConversationService } from './pm.conversations.js';
import type { RunTokenEnv } from '../run/agent-api.routes.js';
import type { PmService } from './pm.service.js';

/**
 * `/np/pm` (browser; NP-183 protocol-pm-assistant.md §5.4): the member's conversations — `GET /conversations?q&archived&
 * cursor&limit`, `POST /conversations { title?, switchTo? }` (201), `GET|PATCH /conversations/:id`,
 * `POST /conversations/:id/fallback|restore` — and the iteration-4 alias `GET|POST /conversation` (`{ issueId,
 * identifier, agentId }`, the latest unarchived conversation). 409 `PM_NOT_CONFIGURED` without a usable project
 * manager; somebody else's conversation is 404.
 */
export function createPmRoutes(
  conversations: ConversationService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/conversation', async (context) =>
    context.json({
      data: await conversations.legacy(sessionActor(context), false),
    }),
  );
  routes.post('/conversation', async (context) =>
    context.json({
      data: await conversations.legacy(sessionActor(context), true),
    }),
  );
  routes.get('/conversations', async (context) =>
    context.json(
      await conversations.list(sessionActor(context), {
        q: queryText(context, 'q'),
        archived: queryText(context, 'archived') === 'true',
        cursor: queryText(context, 'cursor'),
        limit: queryInt(context, 'limit'),
      }),
    ),
  );
  routes.post('/conversations', async (context) =>
    context.json(
      {
        data: await conversations.create(
          sessionActor(context),
          await readJson<PmConversationCreateRequest>(context),
        ),
      },
      201,
    ),
  );
  routes.get('/conversations/:id', async (context) =>
    context.json({
      data: await conversations.get(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
  routes.patch('/conversations/:id', async (context) =>
    context.json({
      data: await conversations.patch(
        sessionActor(context),
        context.req.param('id'),
        await readJson<PmConversationPatch>(context),
      ),
    }),
  );
  routes.post('/conversations/:id/fallback', async (context) =>
    context.json({
      data: await conversations.fallback(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
  routes.post('/conversations/:id/restore', async (context) =>
    context.json({
      data: await conversations.restore(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
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

/**
 * `/np/me/pm-agent` (browser, NP-183 protocol-pm-assistant.md §6.2): `GET /` → `PmAgentChoice`; `PUT / { revision,
 * mode, agentId? }` saves the choice for new conversations (400 `PM_AGENT_NOT_ELIGIBLE` with `details.reason`);
 * `POST /copy-from-default { runtimeId, model?, reasoningEffort?, name? }` (201) creates the member's own project
 * manager from the system default and chooses it.
 */
export function createPmAgentRoutes(pmAgents: PmAgentService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await pmAgents.choice(sessionActor(context)) }),
  );
  routes.put('/', async (context) =>
    context.json({
      data: await pmAgents.choose(
        sessionActor(context),
        await readJson<PmAgentChoiceRequest>(context),
      ),
    }),
  );
  routes.post('/copy-from-default', async (context) =>
    context.json(
      {
        data: await pmAgents.copyFromDefault(
          sessionActor(context),
          await readJson<PmAgentCopyRequest>(context),
        ),
      },
      201,
    ),
  );
  return routes;
}
