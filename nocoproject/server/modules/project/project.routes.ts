import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  AddProjectMemberRequest,
  CreateProjectRequest,
  CreateProjectResourceRequest,
  ProjectDetailV3,
  UpdateProjectRequest,
  UpdateProjectResourceRequest,
} from '../shared/protocol.js';
import type { KnowledgeService } from '../knowledge/knowledge.service.js';
import type { ProjectService } from './project.service.js';

/**
 * `/np/projects` (browser, contract §F). Authentication is installed by the owning contribution. Iteration 3 §B:
 * `GET /:id` adds `knowledgeDocs` (the project's own live documents) from the knowledge service.
 */
export function createProjectRoutes(
  projects: ProjectService,
  knowledge: Pick<KnowledgeService, 'projectDocs'>,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await projects.list(sessionActor(context)) }),
  );
  routes.post('/', async (context) => {
    const project = await projects.create(
      sessionActor(context),
      await readJson<CreateProjectRequest>(context),
    );
    return context.json({ data: project }, 201);
  });
  routes.get('/:id', async (context) => {
    const actor = sessionActor(context);
    const project = await projects.get(actor, context.req.param('id'));
    const data: ProjectDetailV3 = {
      ...project,
      knowledgeDocs: await knowledge.projectDocs(actor, project.id),
    };
    return context.json({ data });
  });
  routes.patch('/:id', async (context) =>
    context.json({
      data: await projects.update(
        sessionActor(context),
        context.req.param('id'),
        await readJson<UpdateProjectRequest>(context),
      ),
    }),
  );
  routes.delete('/:id', async (context) => {
    await projects.remove(sessionActor(context), context.req.param('id'));
    return context.json({ data: { ok: true } });
  });
  routes.post('/:id/members', async (context) =>
    context.json(
      {
        data: await projects.addMember(
          sessionActor(context),
          context.req.param('id'),
          await readJson<AddProjectMemberRequest>(context),
        ),
      },
      201,
    ),
  );
  routes.delete('/:id/members/:userId', async (context) =>
    context.json({
      data: await projects.removeMember(
        sessionActor(context),
        context.req.param('id'),
        context.req.param('userId'),
      ),
    }),
  );
  routes.post('/:id/resources', async (context) =>
    context.json(
      {
        data: await projects.addResource(
          sessionActor(context),
          context.req.param('id'),
          await readJson<CreateProjectResourceRequest>(context),
        ),
      },
      201,
    ),
  );
  routes.patch('/:id/resources/:rid', async (context) =>
    context.json({
      data: await projects.updateResource(
        sessionActor(context),
        context.req.param('id'),
        context.req.param('rid'),
        await readJson<UpdateProjectResourceRequest>(context),
      ),
    }),
  );
  routes.delete('/:id/resources/:rid', async (context) => {
    await projects.removeResource(
      sessionActor(context),
      context.req.param('id'),
      context.req.param('rid'),
    );
    return context.json({ data: { ok: true } });
  });
  return routes;
}
