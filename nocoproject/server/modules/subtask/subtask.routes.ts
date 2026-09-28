import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { invalid } from '../shared/errors.js';
import { npRouter, queryText, readJson, sessionActor } from '../shared/http.js';
import type {
  AddDependencyRequest,
  DecideProposalRequest,
} from '../shared/protocol.js';
import type { DependencyService } from './dependency.service.js';
import type { ProposalService } from './proposal.service.js';

function optionalJson<T>(text: string): T {
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw invalid('INVALID_JSON', 'Request body must be JSON.');
  }
}

/** Dependencies and executor proposals under `/np/issues/:id` (browser, contract §D). */
export function createSubtaskRoutes(deps: {
  dependencies: DependencyService;
  proposals: ProposalService;
}): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.post('/:id/dependencies', async (context) =>
    context.json(
      {
        data: await deps.dependencies.add(
          sessionActor(context),
          context.req.param('id'),
          await readJson<AddDependencyRequest>(context),
        ),
      },
      201,
    ),
  );
  // `?dependsOnIssueId=<id or identifier>` form, the same as the agent API.
  routes.delete('/:id/dependencies', async (context) => {
    const target = queryText(context, 'dependsOnIssueId');
    if (!target)
      throw invalid('INVALID_DEPENDENCY', 'dependsOnIssueId is required.');
    await deps.dependencies.remove(
      sessionActor(context),
      context.req.param('id'),
      target,
    );
    return context.json({ data: { ok: true } });
  });
  routes.delete('/:id/dependencies/:dependencyId', async (context) => {
    await deps.dependencies.remove(
      sessionActor(context),
      context.req.param('id'),
      context.req.param('dependencyId'),
    );
    return context.json({ data: { ok: true } });
  });
  routes.post('/:id/proposals/accept-all', async (context) =>
    context.json({
      data: await deps.proposals.acceptAll(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
  for (const decision of ['accept', 'reject'] as const) {
    routes.post(`/:id/proposals/:proposalId/${decision}`, async (context) => {
      const body = optionalJson<DecideProposalRequest>(
        await context.req.text(),
      );
      return context.json({
        data: await deps.proposals[decision](
          sessionActor(context),
          context.req.param('id'),
          context.req.param('proposalId'),
          body,
        ),
      });
    });
  }
  return routes;
}
