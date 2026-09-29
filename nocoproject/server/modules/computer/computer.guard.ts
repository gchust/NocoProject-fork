/**
 * The daemon guard (NP-150): `/np/daemon/*` accepts a computer credential (`x-np-computer-key`) or, for CLIs from
 * before it, the owner's personal API key through the session (`auth.required()`).
 *
 * A computer credential never becomes a session, so the guard sets the request's `auth` to its owner itself; the
 * daemon routes read only `auth.user.id` from it (`sessionUserId`). It also binds the credential to one daemon:
 * register, heartbeat, claim and deregister must name the daemon id of the credential's first register, and
 * `runs/:id/*` must be a run of that daemon.
 */
import type { AuthEnv, AuthSession } from '@nocobase/app-plugin-authentication';
import type { Context, MiddlewareHandler } from 'hono';

import { COMPUTER_KEY_HEADER, type DaemonCredential } from '../shared/protocol.js';
import type { ComputerCaller, ComputerService } from './computer.service.js';

export const DAEMON_CALLER_VARIABLE = 'npDaemonCaller';

export interface DaemonCaller {
  readonly credential: DaemonCredential;
  readonly computer: ComputerCaller | null;
}

export interface DaemonCallerEnv {
  Variables: { npDaemonCaller?: DaemonCaller };
}

export function daemonCaller(context: Pick<Context, 'get'>): DaemonCaller {
  return (
    (context as unknown as Pick<Context<DaemonCallerEnv>, 'get'>).get(
      DAEMON_CALLER_VARIABLE,
    ) ?? { credential: 'personalKey', computer: null }
  );
}

const BOUND_PATHS = new Set([
  '/np/daemon/register',
  '/np/daemon/heartbeat',
  '/np/daemon/deregister',
  '/np/daemon/runs/claim',
]);
const RUN_PATH = /^\/np\/daemon\/runs\/([^/]+)\//u;

export function daemonAuthentication(
  personalKey: MiddlewareHandler<AuthEnv>,
  computers: ComputerService,
): MiddlewareHandler {
  return async (context, next) => {
    const secret = context.req.header(COMPUTER_KEY_HEADER);
    const set = (caller: DaemonCaller) =>
      (context as unknown as Context<DaemonCallerEnv>).set(
        DAEMON_CALLER_VARIABLE,
        caller,
      );
    if (secret === undefined) {
      set({ credential: 'personalKey', computer: null });
      return personalKey(context as unknown as Context<AuthEnv>, next);
    }
    const computer = await computers.authenticate(secret);
    const path = new URL(context.req.url).pathname.replace(/^.*?(\/np\/daemon\/)/u, '$1');
    if (context.req.method === 'POST' && BOUND_PATHS.has(path)) {
      const body = (await context.req
        .json()
        .catch(() => null)) as { daemonId?: unknown } | null;
      if (typeof body?.daemonId === 'string')
        await computers.bindDaemon(computer, body.daemonId);
    }
    const run = RUN_PATH.exec(path);
    if (run && run[1] !== 'claim')
      await computers.requireRun(computer, decodeURIComponent(run[1]!));
    set({ credential: 'computer', computer });
    (context as unknown as Context<AuthEnv>).set('auth', {
      user: { id: computer.ownerUserId },
    } as unknown as AuthSession);
    await next();
  };
}
