import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import type { ClaimService } from '../run/claim.service.js';
import { daemonCaller } from '../computer/computer.guard.js';
import type { DaemonWakeups } from './daemon-wakeups.js';
import {
  npRouter,
  queryInt,
  readJson,
  serverUrlOf,
  sessionUserId,
} from '../shared/http.js';
import type { DaemonClaimRequest } from '../shared/protocol.js';
import { compatibilityInfo } from './daemon-compat.js';
import type {
  HeartbeatRequest,
  RegisterRequest,
  RuntimeService,
} from './runtime.service.js';

/**
 * `/np/daemon/{register,heartbeat,deregister,runs/claim,compatibility}`. The caller is the API key owner; every runtime it touches
 * must be its own (enforced by the services, answered with 403).
 */
export function createDaemonRoutes(deps: {
  runtimes: RuntimeService;
  claims: ClaimService;
  wakeups: DaemonWakeups;
  publicBasePath?: string;
}): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.post('/register', async (context) =>
    context.json({
      data: await deps.runtimes.register(
        sessionUserId(context),
        await readJson<RegisterRequest>(context),
        daemonCaller(context).credential,
      ),
    }),
  );
  routes.post('/heartbeat', async (context) => {
    const result = await deps.runtimes.heartbeat(
      sessionUserId(context),
      await readJson<HeartbeatRequest>(context),
    );
    return context.json({
      data: {
        ok: true,
        ...(result.compatibility
          ? { compatibility: result.compatibility }
          : {}),
      },
    });
  });
  // Long-poll wakeups for daemons without a WebSocket session (computer credentials, NP-150).
  routes.get('/wakeups', async (context) => {
    const after = queryInt(context, 'after');
    const timeout = queryInt(context, 'timeout') ?? 25;
    return context.json({
      data: await deps.wakeups.wait(
        sessionUserId(context),
        after,
        timeout * 1000,
        context.req.raw.signal,
      ),
    });
  });
  routes.get('/compatibility', (context) =>
    context.json({
      data: compatibilityInfo(serverUrlOf(context, deps.publicBasePath)),
    }),
  );
  routes.post('/deregister', async (context) => {
    const body = await readJson<{ daemonId: string }>(context);
    await deps.runtimes.deregister(sessionUserId(context), body.daemonId);
    return context.json({ data: { ok: true } });
  });
  routes.post('/runs/claim', async (context) =>
    context.json({
      data: await deps.claims.claim(
        sessionUserId(context),
        await readJson<DaemonClaimRequest>(context),
        serverUrlOf(context, deps.publicBasePath),
      ),
    }),
  );
  return routes;
}
