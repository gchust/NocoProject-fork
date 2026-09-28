import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, queryText, sessionActor } from '../shared/http.js';
import type { MetricsService } from './metrics.service.js';

/** `GET /np/metrics?from=&to=&projectId=` (browser, iteration-3 contract §C) → `{ data: MetricsReport }`. */
export function createMetricsRoutes(metrics: MetricsService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({
      data: await metrics.report(sessionActor(context), {
        from: queryText(context, 'from'),
        to: queryText(context, 'to'),
        projectId: queryText(context, 'projectId'),
      }),
    }),
  );
  return routes;
}
