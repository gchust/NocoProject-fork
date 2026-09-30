import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { UpdateRuntimeRequest } from '../shared/protocol.js';
import type { RuntimeService } from './runtime.service.js';

/**
 * `/np/runtimes` (browser): list, and `PATCH /:id { visibility }` by the runtime owner; NP-183 `{ pmAllowed }` by an
 * owner / admin.
 */
export function createRuntimeRoutes(runtimes: RuntimeService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await runtimes.list() }),
  );
  routes.patch('/:id', async (context) => {
    const body = await readJson<
      UpdateRuntimeRequest & { readonly pmAllowed?: unknown }
    >(context);
    const actor = sessionActor(context);
    const id = context.req.param('id');
    let data =
      body.visibility !== undefined || body.pmAllowed === undefined
        ? await runtimes.setVisibility(actor, id, body.visibility)
        : null;
    if (body.pmAllowed !== undefined)
      data = await runtimes.setPmAllowed(actor, id, body.pmAllowed);
    return context.json({ data });
  });
  return routes;
}
