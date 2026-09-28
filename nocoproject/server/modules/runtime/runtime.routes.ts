import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { UpdateRuntimeRequest } from '../shared/protocol.js';
import type { RuntimeService } from './runtime.service.js';

/** `/np/runtimes` (browser): list, and `PATCH /:id { visibility }` by the runtime owner. */
export function createRuntimeRoutes(runtimes: RuntimeService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await runtimes.list() }),
  );
  routes.patch('/:id', async (context) => {
    const body = await readJson<UpdateRuntimeRequest>(context);
    return context.json({
      data: await runtimes.setVisibility(
        sessionActor(context),
        context.req.param('id'),
        body.visibility,
      ),
    });
  });
  return routes;
}
