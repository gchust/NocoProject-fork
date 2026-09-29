import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  CreateAgentRequestV4,
  UpdateAgentRequestV4,
} from '../shared/protocol.js';
import type { AgentService } from './agent.service.js';

/** `/np/agents` (browser). Every row carries `canInvoke` / `canEdit` for the caller. */
export function createAgentRoutes(agents: AgentService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await agents.list(sessionActor(context)) }),
  );
  routes.get('/:id', async (context) =>
    context.json({
      data: await agents.get(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.post('/', async (context) => {
    const agent = await agents.create(
      sessionActor(context),
      await readJson<CreateAgentRequestV4>(context),
    );
    return context.json({ data: agent }, 201);
  });
  routes.patch('/:id', async (context) => {
    const agent = await agents.update(
      sessionActor(context),
      context.req.param('id'),
      await readJson<UpdateAgentRequestV4>(context),
    );
    return context.json({ data: agent });
  });
  routes.delete('/:id', async (context) => {
    await agents.remove(sessionActor(context), context.req.param('id'));
    return context.json({ ok: true });
  });
  return routes;
}
