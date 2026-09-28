import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Context, Hono } from 'hono';

import { invalid } from '../shared/errors.js';
import { npRouter, queryText, readJson, sessionActor } from '../shared/http.js';
import type {
  AgentKnowledgeProposalRequest,
  CreateKnowledgeDocRequest,
  DecideKnowledgeProposalRequest,
  UpdateKnowledgeDocRequest,
} from '../shared/protocol.js';
import type { RunTokenEnv } from '../run/agent-api.routes.js';
import type { KnowledgeService } from './knowledge.service.js';

/** A body that may be omitted (decisions). */
async function optionalJson<T>(context: Context): Promise<T> {
  const text = await context.req.text();
  if (!text.trim()) return {} as T;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as T;
  } catch {
    // Falls through to the error below.
  }
  throw invalid('INVALID_JSON', 'Request body must be a JSON object.');
}

/**
 * `/np/knowledge` (browser, iteration-3 contract §B). Readers: members who can see the project (system-level
 * documents: every member); writers: the project lead or owner/admin (system-level: owner/admin). `GET /` takes
 * `projectId` (an id, or `none` for system-level only), `q` and `includeArchived=1`.
 */
export function createKnowledgeRoutes(
  knowledge: KnowledgeService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({
      data: await knowledge.list(sessionActor(context), {
        projectId: queryText(context, 'projectId'),
        q: queryText(context, 'q'),
        includeArchived: ['1', 'true'].includes(
          queryText(context, 'includeArchived') ?? '',
        ),
      }),
    }),
  );
  routes.post('/', async (context) =>
    context.json(
      {
        data: await knowledge.create(
          sessionActor(context),
          await readJson<CreateKnowledgeDocRequest>(context),
        ),
      },
      201,
    ),
  );
  // Before `/:id`, so `proposals` is not read as a document id.
  routes.get('/proposals', async (context) =>
    context.json({
      data: await knowledge.proposals(
        sessionActor(context),
        queryText(context, 'status'),
      ),
    }),
  );
  for (const decision of ['accept', 'reject'] as const) {
    routes.post(`/proposals/:id/${decision}`, async (context) =>
      context.json({
        data: await knowledge.decide(
          sessionActor(context),
          context.req.param('id'),
          decision,
          await optionalJson<DecideKnowledgeProposalRequest>(context),
        ),
      }),
    );
  }
  routes.get('/:id', async (context) =>
    context.json({
      data: await knowledge.detail(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
  routes.patch('/:id', async (context) =>
    context.json({
      data: await knowledge.update(
        sessionActor(context),
        context.req.param('id'),
        await readJson<UpdateKnowledgeDocRequest>(context),
      ),
    }),
  );
  routes.get('/:id/versions/:version', async (context) => {
    const version = Number(context.req.param('version'));
    if (!Number.isInteger(version) || version < 1)
      throw invalid('INVALID_VERSION', 'version must be a positive integer.');
    return context.json({
      data: await knowledge.version(
        sessionActor(context),
        context.req.param('id'),
        version,
      ),
    });
  });
  for (const [action, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const) {
    routes.post(`/:id/${action}`, async (context) =>
      context.json({
        data: await knowledge.setArchived(
          sessionActor(context),
          context.req.param('id'),
          archived,
        ),
      }),
    );
  }
  return routes;
}

/**
 * `/np/agent/knowledge*` (run token, iteration-3 contract §B): the run's project and system-level documents only;
 * archived documents are invisible. Mounted inside the agent API's guarded router, so paths carry the prefix.
 */
export function createAgentKnowledgeRoutes(
  knowledge: KnowledgeService,
): Hono<RunTokenEnv> {
  const routes = npRouter<RunTokenEnv>();
  routes.get('/knowledge', async (context) =>
    context.json({ data: await knowledge.agentList(context.get('runAuth')) }),
  );
  routes.post('/knowledge/proposals', async (context) =>
    context.json(
      {
        data: await knowledge.agentPropose(
          context.get('runAuth'),
          await readJson<AgentKnowledgeProposalRequest>(context),
        ),
      },
      201,
    ),
  );
  routes.get('/knowledge/:idOrSlug', async (context) =>
    context.json({
      data: {
        doc: await knowledge.agentGet(
          context.get('runAuth'),
          context.req.param('idOrSlug'),
        ),
      },
    }),
  );
  return routes;
}
