import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  CreateLabelRequest,
  UpdateLabelRequest,
} from '../shared/protocol.js';
import type { LabelService } from './label.service.js';

/** `/np/labels` (browser). */
export function createLabelRoutes(labels: LabelService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await labels.list() }),
  );
  routes.post('/', async (context) => {
    const label = await labels.create(
      sessionActor(context),
      await readJson<CreateLabelRequest>(context),
    );
    return context.json({ data: label }, 201);
  });
  routes.patch('/:id', async (context) =>
    context.json({
      data: await labels.update(
        sessionActor(context),
        context.req.param('id'),
        await readJson<UpdateLabelRequest>(context),
      ),
    }),
  );
  routes.delete('/:id', async (context) => {
    await labels.remove(sessionActor(context), context.req.param('id'));
    return context.json({ data: { ok: true } });
  });
  return routes;
}
