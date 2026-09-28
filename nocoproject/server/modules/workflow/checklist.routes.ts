import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { UpdateChecklistItemRequest } from '../shared/protocol.js';
import type { RunTokenEnv } from '../run/agent-api.routes.js';
import type { ChecklistService } from './checklist.js';

const ITEM_PATH = '/issues/:id/checklists/:statusKey/items/:itemKey';

/**
 * Browser, mounted under `/np/issues` (NP-77 §6): `GET /:id/checklists` answers `{ data: IssueChecklist[] }`;
 * `PATCH /:id/checklists/:statusKey/items/:itemKey { checked }` answers `{ data: IssueChecklist }`.
 */
export function createChecklistRoutes(
  checklists: ChecklistService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/:id/checklists', async (context) =>
    context.json({
      data: await checklists.list(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
  routes.patch('/:id/checklists/:statusKey/items/:itemKey', async (context) =>
    context.json({
      data: await checklists.set(
        sessionActor(context),
        context.req.param('id'),
        context.req.param('statusKey'),
        context.req.param('itemKey'),
        await readJson<UpdateChecklistItemRequest>(context),
      ),
    }),
  );
  return routes;
}

/** Agent API, mounted under `/np/agent`: the same two endpoints; writes only on the run's own issue. */
export function createAgentChecklistRoutes(
  checklists: ChecklistService,
): Hono<RunTokenEnv> {
  const routes = npRouter<RunTokenEnv>();
  routes.get('/issues/:id/checklists', async (context) =>
    context.json({
      data: await checklists.agentList(
        context.get('runAuth'),
        context.req.param('id'),
      ),
    }),
  );
  routes.patch(ITEM_PATH, async (context) =>
    context.json({
      data: await checklists.agentSet(
        context.get('runAuth'),
        context.req.param('id'),
        context.req.param('statusKey'),
        context.req.param('itemKey'),
        await readJson<UpdateChecklistItemRequest>(context),
      ),
    }),
  );
  return routes;
}
