import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, queryText, sessionActor } from '../shared/http.js';
import type { UsageService } from './usage.service.js';

/**
 * `GET /np/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=agent|issue|project|day|model&projectId=&agentId=&issueId=` (browser,
 * contract §I) → `{ data: { rows, totals } }`. The range defaults to the last 30 days (UTC).
 */
export function createUsageRoutes(usage: UsageService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({
      data: await usage.query(sessionActor(context), {
        from: queryText(context, 'from'),
        to: queryText(context, 'to'),
        groupBy: queryText(context, 'groupBy'),
        projectId: queryText(context, 'projectId'),
        agentId: queryText(context, 'agentId'),
        issueId: queryText(context, 'issueId'),
      }),
    }),
  );
  return routes;
}
