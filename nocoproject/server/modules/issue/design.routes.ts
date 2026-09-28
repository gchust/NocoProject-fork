import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import type { RunTokenEnv } from '../run/agent-api.routes.js';
import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  AgentDesignProposalRequest,
  DesignApproveRequest,
  DesignRequestChangesRequest,
} from '../shared/protocol.js';
import type { DesignService } from './design.service.js';
import { optionalJson } from './issue.routes.js';

/**
 * `/np/issues/:id/design/*` (browser, iteration-4 contract §B), mounted beside the issue routes:
 *
 * - `POST /:id/design/approve { comment? }` (body may be omitted) → `{ data: DesignDecisionResult }`;
 * - `POST /:id/design/request-changes { comment }` → `{ data: DesignDecisionResult }`.
 */
export function createDesignRoutes(design: DesignService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.post('/:id/design/approve', async (context) =>
    context.json({
      data: await design.approve(
        sessionActor(context),
        context.req.param('id'),
        await optionalJson<DesignApproveRequest>(context),
      ),
    }),
  );
  routes.post('/:id/design/request-changes', async (context) =>
    context.json({
      data: await design.requestChanges(
        sessionActor(context),
        context.req.param('id'),
        await readJson<DesignRequestChangesRequest>(context),
      ),
    }),
  );
  return routes;
}

/**
 * `POST /np/agent/issues/:id/design-proposal { content }` (run token, the run's own issue) → 201
 * `{ data: CommentV2 }` (a top-level `kind = 'proposal'` comment).
 */
export function createAgentDesignRoutes(
  design: DesignService,
): Hono<RunTokenEnv> {
  const routes = npRouter<RunTokenEnv>();
  routes.post('/issues/:id/design-proposal', async (context) =>
    context.json(
      {
        data: await design.propose(
          context.get('runAuth'),
          context.req.param('id'),
          await readJson<AgentDesignProposalRequest>(context),
        ),
      },
      201,
    ),
  );
  return routes;
}
