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
  PmActRequest,
  PmPlanCreateRequest,
  PmPlanEditRequest,
  PmAgentChoiceRequest,
  PmAgentCopyRequest,
  PmConversationCreateRequest,
  PmConversationPatch,
} from '../shared/protocol.js';
import type { PmAgentService } from './pm-agent.service.js';
import type { PmActService } from './pm-act.service.js';
import type { PmPlanService } from './pm.plans.js';
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
  plans?: PmPlanService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  if (plans) mountPlanRoutes(routes, plans);
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
 * - NP-183: `GET /pm/agents` (roster), `GET /pm/runs?issueId`, `GET /pm/runs/:id/events?limit` (≤ 200),
 *   `GET /pm/pull-requests?issueId`; `POST /pm/act { op }` and `POST /pm/conversation/title { title }` (`member.act`,
 *   conversation runs only, 403 `NOT_CONVERSATION_RUN`)
 */
export function createAgentPmRoutes(
  pm: PmService,
  assistant?: {
    readonly act: PmActService;
    readonly conversations: ConversationService;
    readonly plans?: PmPlanService;
  },
): Hono<RunTokenEnv> {
  const routes = npRouter<RunTokenEnv>();
  // NP-183 (protocol-pm-assistant.md §7.1): the roster, runs, run events and pull requests.
  routes.get('/pm/agents', async (context) =>
    context.json({ data: await pm.agents(context.get('runAuth')) }),
  );
  routes.get('/pm/runs', async (context) =>
    context.json({
      data: await pm.runs(
        context.get('runAuth'),
        queryText(context, 'issueId') ?? '',
      ),
    }),
  );
  routes.get('/pm/runs/:id/events', async (context) =>
    context.json(
      await pm.runEvents(
        context.get('runAuth'),
        context.req.param('id'),
        queryInt(context, 'limit'),
      ),
    ),
  );
  routes.get('/pm/pull-requests', async (context) =>
    context.json({
      data: await pm.pullRequests(
        context.get('runAuth'),
        queryText(context, 'issueId') ?? '',
      ),
    }),
  );
  if (assistant?.plans) mountAgentPlanRoutes(routes, assistant.plans);
  if (assistant) {
    // NP-183 (§3, §5.5): direct writes in the asker's name, and the agent's conversation title.
    routes.post('/pm/act', async (context) =>
      context.json({
        data: await assistant.act.act(
          context.get('runAuth'),
          await readJson<PmActRequest>(context),
        ),
      }),
    );
    routes.post('/pm/conversation/title', async (context) => {
      const auth = context.get('runAuth');
      const conversation = await assistant.act.conversationRun(auth);
      const body = await readJson<{ title?: unknown }>(context);
      return context.json({
        data: await assistant.conversations.agentTitle(
          conversation.issueId,
          body?.title,
        ),
      });
    });
  }
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

/**
 * `/np/pm` plan routes (browser, the plan's owner only; NP-183 §4.4): `GET /plans/:id`, `PATCH /plans/:id
 * { revision, ops }`, `POST /plans/:id/execute { revision }`, `POST /plans/:id/discard`, and
 * `GET /conversations/:id/plans` (the plans of one conversation, newest first).
 */
function mountPlanRoutes(routes: Hono<AuthEnv>, plans: PmPlanService): void {
  routes.get('/plans/:id', async (context) =>
    context.json({
      data: await plans.get(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.patch('/plans/:id', async (context) =>
    context.json({
      data: await plans.edit(
        sessionActor(context),
        context.req.param('id'),
        await readJson<PmPlanEditRequest>(context),
      ),
    }),
  );
  routes.post('/plans/:id/execute', async (context) =>
    context.json({
      data: await plans.execute(
        sessionActor(context),
        context.req.param('id'),
        await readJson<{ revision?: unknown }>(context),
      ),
    }),
  );
  routes.post('/plans/:id/discard', async (context) =>
    context.json({
      data: await plans.discard(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.get('/conversations/:id/plans', async (context) =>
    context.json({
      data: await plans.ofConversation(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
}

/**
 * `/np/agent/pm/plans*` (run token, `member.act`, conversation runs only; NP-183 §4.4): `POST /pm/plans { title,
 * summary?, ops }` (201; 400 `PLAN_INVALID` with `details.rows`), `GET /pm/plans?status`, `GET /pm/plans/:id`,
 * `POST /pm/plans/:id/discard`.
 */
function mountAgentPlanRoutes(
  routes: Hono<RunTokenEnv>,
  plans: PmPlanService,
): void {
  routes.post('/pm/plans', async (context) =>
    context.json(
      {
        data: await plans.create(
          context.get('runAuth'),
          await readJson<PmPlanCreateRequest>(context),
        ),
      },
      201,
    ),
  );
  routes.get('/pm/plans', async (context) =>
    context.json({
      data: await plans.agentList(
        context.get('runAuth'),
        queryText(context, 'status'),
      ),
    }),
  );
  routes.get('/pm/plans/:id', async (context) =>
    context.json({
      data: await plans.agentGet(
        context.get('runAuth'),
        context.req.param('id'),
      ),
    }),
  );
  routes.post('/pm/plans/:id/discard', async (context) =>
    context.json({
      data: await plans.agentDiscard(
        context.get('runAuth'),
        context.req.param('id'),
      ),
    }),
  );
}
