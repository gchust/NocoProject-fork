import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  AgentWorkflowProposalRequest,
  DecideWorkflowProposalRequest,
  UpdateWorkflowRequest,
} from '../shared/protocol.js';
import { optionalJson } from '../issue/issue.routes.js';
import type { RunTokenEnv } from '../run/agent-api.routes.js';
import type { WorkflowProposalService } from './workflow.proposals.js';
import type { WorkflowService } from './workflow.service.js';

/**
 * `/np/workflows` (browser). Every member reads templates; NP-77 stage 2 adds the proposal decisions
 * (`GET /proposals/:id`, `POST /proposals/:id/accept|reject`, owner/admin), the revision history
 * (`GET /:id/revisions`) and the admin write `PUT /:id` (owner/admin, no page).
 */
export function createWorkflowRoutes(
  workflows: WorkflowService,
  proposals: WorkflowProposalService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await workflows.list() }),
  );
  // Before `/:id`, so `proposals` is not read as a template id.
  routes.get('/proposals/:id', async (context) =>
    context.json({
      data: await proposals.get(sessionActor(context), context.req.param('id')),
    }),
  );
  for (const decision of ['accept', 'reject'] as const) {
    routes.post(`/proposals/:id/${decision}`, async (context) =>
      context.json({
        data: await proposals.decide(
          sessionActor(context),
          context.req.param('id'),
          decision,
          await optionalJson<DecideWorkflowProposalRequest>(context),
        ),
      }),
    );
  }
  routes.get('/:id', async (context) =>
    context.json({ data: await workflows.get(context.req.param('id')) }),
  );
  routes.get('/:id/revisions', async (context) =>
    context.json({
      data: await proposals.revisions(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
  routes.put('/:id', async (context) =>
    context.json({
      data: await proposals.update(
        sessionActor(context),
        context.req.param('id'),
        await readJson<UpdateWorkflowRequest>(context),
      ),
    }),
  );
  return routes;
}

/**
 * `/np/agent/workflows*` (run token, NP-77 stage 2): read every template (`usedByRunProject` marks the one the run's
 * project uses) and propose changes. There is no agent write: a proposal takes effect only when a person accepts it.
 */
export function createAgentWorkflowRoutes(
  proposals: WorkflowProposalService,
): Hono<RunTokenEnv> {
  const routes = npRouter<RunTokenEnv>();
  routes.get('/workflows', async (context) =>
    context.json({ data: await proposals.agentList(context.get('runAuth')) }),
  );
  routes.post('/workflows/proposals', async (context) =>
    context.json(
      {
        data: await proposals.agentPropose(
          context.get('runAuth'),
          await readJson<AgentWorkflowProposalRequest>(context),
        ),
      },
      201,
    ),
  );
  routes.get('/workflows/:id', async (context) =>
    context.json({
      data: await proposals.agentGet(
        context.get('runAuth'),
        context.req.param('id'),
      ),
    }),
  );
  return routes;
}
