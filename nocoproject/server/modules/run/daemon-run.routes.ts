import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import type { RuntimeService } from '../runtime/runtime.service.js';
import {
  errorBody,
  npRouter,
  readJson,
  sessionUserId,
} from '../shared/http.js';
import type {
  DaemonCompleteRequest,
  DaemonEventsRequest,
  DaemonFailRequest,
  DaemonStartRequest,
} from '../shared/protocol.js';
import type { RunRecoveryService } from './failure.js';
import type { RunEventService } from './run-events.js';
import type { RunService } from './run.service.js';

/**
 * `/np/daemon/runs/:id/*`: the run lifecycle as reported by the daemon. Only the daemon whose API key owns the run's
 * runtime may call these (protocol.md §4, last paragraph).
 */
export function createDaemonRunRoutes(deps: {
  runs: RunService;
  events: RunEventService;
  recovery: RunRecoveryService;
  runtimes: RuntimeService;
}): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();

  routes.use('/runs/:id/*', async (context, next) => {
    const runId = context.req.param('id');
    // `POST /runs/claim` shares the prefix but is not a run; it is authorized per runtime by the claim service.
    if (runId === 'claim') return next();
    const access = await deps.runtimes.runAccess(runId, sessionUserId(context));
    if (access === 'notFound')
      return context.json(errorBody('NOT_FOUND', 'Run not found.'), 404);
    if (access === 'forbidden') {
      return context.json(
        errorBody(
          'RUN_NOT_OWNED',
          'This run belongs to another runtime owner.',
        ),
        403,
      );
    }
    await next();
  });

  routes.post('/runs/:id/lease', async (context) =>
    context.json({
      data: await deps.runs.extendLease(context.req.param('id')),
    }),
  );
  routes.post('/runs/:id/start', async (context) =>
    context.json({
      data: await deps.runs.start(
        context.req.param('id'),
        await readJson<DaemonStartRequest>(context),
      ),
    }),
  );
  routes.post('/runs/:id/events', async (context) => {
    const body = await readJson<DaemonEventsRequest>(context);
    return context.json({
      data: await deps.events.append(context.req.param('id'), body.events),
    });
  });
  routes.get('/runs/:id/status', async (context) =>
    context.json({
      data: await deps.runs.daemonStatus(context.req.param('id')),
    }),
  );
  routes.post('/runs/:id/complete', async (context) =>
    context.json({
      data: await deps.runs.complete(
        context.req.param('id'),
        await readJson<DaemonCompleteRequest>(context),
      ),
    }),
  );
  routes.post('/runs/:id/fail', async (context) =>
    context.json({
      data: await deps.recovery.fail(
        context.req.param('id'),
        await readJson<DaemonFailRequest>(context),
      ),
    }),
  );
  routes.post('/runs/:id/cancel-ack', async (context) =>
    context.json({ data: await deps.runs.cancelAck(context.req.param('id')) }),
  );
  return routes;
}
