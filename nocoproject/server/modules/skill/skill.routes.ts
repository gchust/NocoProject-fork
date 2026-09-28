import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  CreateSkillRequest,
  PutSkillFilesRequest,
  UpdateSkillRequest,
} from '../shared/protocol.js';
import type { SkillService } from './skill.service.js';

/**
 * `/np/skills` (browser, contract §H): list `Skill[]`; create / get / update / put files answer `SkillDetail`
 * (`{ skill, files }`); delete answers `{ ok: true }`.
 */
export function createSkillRoutes(skills: SkillService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await skills.list(sessionActor(context)) }),
  );
  routes.post('/', async (context) =>
    context.json(
      {
        data: await skills.create(
          sessionActor(context),
          await readJson<CreateSkillRequest>(context),
        ),
      },
      201,
    ),
  );
  routes.get('/:id', async (context) =>
    context.json({
      data: await skills.get(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.patch('/:id', async (context) =>
    context.json({
      data: await skills.update(
        sessionActor(context),
        context.req.param('id'),
        await readJson<UpdateSkillRequest>(context),
      ),
    }),
  );
  routes.delete('/:id', async (context) => {
    await skills.remove(sessionActor(context), context.req.param('id'));
    return context.json({ data: { ok: true } });
  });
  routes.put('/:id/files', async (context) => {
    const body = await readJson<PutSkillFilesRequest>(context);
    return context.json({
      data: await skills.putFiles(
        sessionActor(context),
        context.req.param('id'),
        body.files,
      ),
    });
  });
  return routes;
}
