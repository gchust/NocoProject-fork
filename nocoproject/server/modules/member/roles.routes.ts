import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { RoleService } from './roles.service.js';

/** `/np/access` (browser, NP-153): the catalog of what a business role may hold, and the roles themselves. */
export function createAccessRoutes(roles: RoleService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/catalog', async (context) =>
    context.json({ data: await roles.catalog(sessionActor(context)) }),
  );
  routes.get('/roles', async (context) =>
    context.json({ data: await roles.list(sessionActor(context)) }),
  );
  routes.post('/roles', async (context) =>
    context.json(
      {
        data: await roles.create(
          sessionActor(context),
          await readJson<unknown>(context),
        ),
      },
      201,
    ),
  );
  routes.put('/roles/:key', async (context) =>
    context.json({
      data: await roles.update(
        sessionActor(context),
        context.req.param('key'),
        await readJson<unknown>(context),
      ),
    }),
  );
  routes.delete('/roles/:key', async (context) => {
    await roles.remove(sessionActor(context), context.req.param('key'));
    return context.body(null, 204);
  });
  return routes;
}
