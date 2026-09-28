import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Context, Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  LinkPullRequestRequest,
  MergePullRequestRequest,
  UpdateGitConnectionRequest,
  UpdateIssuePullRequestRequest,
} from '../shared/protocol.js';
import type { GitConnectionService } from './connection.service.js';
import type { PullRequestMergeService } from './merge.service.js';
import type { PullRequestService } from './pull-request.service.js';

/** Where GitHub should deliver webhooks: `${publicOrigin or request origin}${basePath}/np/webhooks/github`. */
export function webhookUrlOf(
  context: Context,
  publicOrigin: string | undefined,
  publicBasePath: string | undefined,
): string {
  const origin = (publicOrigin || new URL(context.req.url).origin).replace(
    /\/+$/u,
    '',
  );
  const base = (publicBasePath ?? '').replace(/\/+$/u, '');
  return `${origin}${base}/np/webhooks/github`;
}

/** `/np/integrations/github` (browser, owner/admin; contract §C). Secrets are never echoed. */
export function createIntegrationRoutes(deps: {
  connections: GitConnectionService;
  publicOrigin?: string;
  publicBasePath?: string;
}): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  const url = (context: Context) =>
    webhookUrlOf(context, deps.publicOrigin, deps.publicBasePath);
  routes.get('/github', async (context) =>
    context.json({
      data: await deps.connections.view(sessionActor(context), url(context)),
    }),
  );
  routes.put('/github', async (context) =>
    context.json({
      data: await deps.connections.update(
        sessionActor(context),
        await readJson<UpdateGitConnectionRequest>(context),
        url(context),
      ),
    }),
  );
  routes.post('/github/test', async (context) =>
    context.json({ data: await deps.connections.test(sessionActor(context)) }),
  );
  return routes;
}

/** `/np/issues/:id/pull-requests[/:prId[/refresh|/merge]]` (browser, contract §C; merge: NP-85). */
export function createIssuePullRequestRoutes(
  prs: PullRequestService,
  merges: PullRequestMergeService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/:id/pull-requests', async (context) =>
    context.json({
      data: await prs.list(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.post('/:id/pull-requests', async (context) => {
    const body = await readJson<LinkPullRequestRequest>(context);
    return context.json(
      {
        data: await prs.link(
          sessionActor(context),
          context.req.param('id'),
          body.url,
        ),
      },
      201,
    );
  });
  routes.delete('/:id/pull-requests/:prId', async (context) => {
    await prs.unlink(
      sessionActor(context),
      context.req.param('id'),
      context.req.param('prId'),
    );
    return context.json({ data: { ok: true } });
  });
  routes.patch('/:id/pull-requests/:prId', async (context) => {
    const body = await readJson<UpdateIssuePullRequestRequest>(context);
    return context.json({
      data: await prs.setAutoComplete(
        sessionActor(context),
        context.req.param('id'),
        context.req.param('prId'),
        body.autoCompleteDisabled,
      ),
    });
  });
  routes.post('/:id/pull-requests/:prId/refresh', async (context) =>
    context.json({
      data: await prs.refresh(
        sessionActor(context),
        context.req.param('id'),
        context.req.param('prId'),
      ),
    }),
  );
  routes.get('/:id/pull-requests/:prId/merge', async (context) =>
    context.json({
      data: await merges.preflight(
        sessionActor(context),
        context.req.param('id'),
        context.req.param('prId'),
      ),
    }),
  );
  routes.post('/:id/pull-requests/:prId/merge', async (context) => {
    const body = await readJson<MergePullRequestRequest>(context);
    return context.json({
      data: await merges.merge(
        sessionActor(context),
        context.req.param('id'),
        context.req.param('prId'),
        body.expectedHeadSha,
      ),
    });
  });
  return routes;
}
