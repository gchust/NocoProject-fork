import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import type { ClaimService } from '../run/claim.service.js';
import {
  npRouter,
  readJson,
  serverUrlOf,
  sessionUserId,
} from '../shared/http.js';
import type {
  DaemonClaimRequest,
  DaemonHeartbeatRequest,
  DaemonRegisterRequest,
} from '../shared/protocol.js';
import type { RuntimeService } from './runtime.service.js';

/**
 * `/np/daemon/{register,heartbeat,deregister,runs/claim}`. The caller is the API key owner; every runtime it touches
 * must be its own (enforced by the services, answered with 403).
 */
export function createDaemonRoutes(deps: {
  runtimes: RuntimeService;
  claims: ClaimService;
  publicBasePath?: string;
}): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.post('/register', async (context) =>
    context.json({
      data: await deps.runtimes.register(
        sessionUserId(context),
        await readJson<DaemonRegisterRequest>(context),
      ),
    }),
  );
  routes.post('/heartbeat', async (context) => {
    await deps.runtimes.heartbeat(
      sessionUserId(context),
      await readJson<DaemonHeartbeatRequest>(context),
    );
    return context.json({ data: { ok: true } });
  });
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
