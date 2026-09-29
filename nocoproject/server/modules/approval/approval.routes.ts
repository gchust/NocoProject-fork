// @temporary(nocobase-official): to be replaced by the official NocoBase workflow approval
import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import type { ApprovalGateway } from '../shared/approval.js';
import { invalid } from '../shared/errors.js';
import { npRouter, queryText, sessionActor } from '../shared/http.js';
import type { DecideApprovalRequest } from '../shared/protocol.js';

function optionalBody(text: string): DecideApprovalRequest {
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw invalid('INVALID_JSON', 'Request body must be JSON.');
  }
}

/**
 * `/np/approvals` (browser, contract §D): the caller's pending requests, and approve / reject (body optional). Only a
 * listed approver may decide (403); a decided request is 409 `APPROVAL_DECIDED`. Uses the gateway interface only.
 */
export function createApprovalRoutes(
  approvals: ApprovalGateway,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) => {
    const status = queryText(context, 'status') ?? 'pending';
    if (status !== 'pending')
      throw invalid('INVALID_STATUS', 'Only status=pending is supported.');
    const actor = sessionActor(context);
    return context.json({
      data: await approvals.listPending(actor.id as string),
    });
  });
  for (const decision of ['approve', 'reject'] as const) {
    routes.post(`/:id/${decision}`, async (context) => {
      const body = optionalBody(await context.req.text());
      const comment = typeof body.comment === 'string' ? body.comment : null;
      return context.json({
        data: await approvals[decision](
          context.req.param('id'),
          sessionActor(context),
          comment,
        ),
      });
    });
  }
  return routes;
}
