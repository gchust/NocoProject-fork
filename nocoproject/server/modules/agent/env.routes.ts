import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { PutAgentEnvRequest } from '../shared/protocol.js';
import type { AgentEnvService } from './env.service.js';

/**
 * `/np/agents/:id/env[...]` (browser, contract §G). Listing never includes values; `POST .../reveal` does and is
 * audited. `PUT` answers the variable list after the upsert.
 */
export function createAgentEnvRoutes(env: AgentEnvService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/:id/env', async (context) =>
    context.json({
      data: await env.list(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.put('/:id/env', async (context) => {
    const body = await readJson<PutAgentEnvRequest>(context);
    return context.json({
      data: await env.put(
        sessionActor(context),
        context.req.param('id'),
        body.vars,
      ),
    });
  });
  routes.get('/:id/env/audits', async (context) =>
    context.json({
      data: await env.audits(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.post('/:id/env/reveal', async (context) =>
    context.json({
      data: await env.reveal(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.delete('/:id/env/:name', async (context) => {
    await env.remove(
      sessionActor(context),
      context.req.param('id'),
      context.req.param('name'),
    );
    return context.json({ data: { ok: true } });
  });
  return routes;
}
