import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { CreateComputerRequest } from '../shared/protocol.js';
import type { ComputerService } from './computer.service.js';

/**
 * `/np/computers` (browser, NP-150): list, `POST { name }` issues a computer credential (the secret is in this one
 * response only), `DELETE /:id` revokes it.
 */
export function createComputerRoutes(
  computers: ComputerService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await computers.list(sessionActor(context)) }),
  );
  routes.post('/', async (context) => {
    const result = await computers.create(
      sessionActor(context),
      await readJson<CreateComputerRequest>(context),
    );
    context.header('cache-control', 'no-store');
    return context.json({ data: result }, 201);
  });
  routes.delete('/:id', async (context) =>
    context.json({
      data: await computers.revoke(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
  return routes;
}
