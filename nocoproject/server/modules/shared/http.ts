/**
 * HTTP helpers shared by the NocoProject route modules: error mapping, body parsing, and the run-token boundary.
 * Only route code imports this file; services never see a Hono context.
 */
import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Context, Env, ErrorHandler, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { Actor, ActorVia } from './activity.js';
import { NpError, type NpErrorKind } from './errors.js';
import type { ApiErrorBody } from './protocol.js';
import { RUN_TOKEN_PREFIX } from './protocol.js';

const STATUS_BY_KIND: Readonly<Record<NpErrorKind, ContentfulStatusCode>> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  upgradeRequired: 426,
  upstream: 502,
  timeout: 504,
};

export function errorBody(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ApiErrorBody {
  return details ? { code, message, details } : { code, message };
}

/** Maps domain errors to `{ code, message, details? }` with their status; anything else is a 500 without internals. */
export const npErrorHandler: ErrorHandler = (error, context) => {
  if (error instanceof NpError) {
    return context.json(
      errorBody(error.code, error.message, error.details),
      STATUS_BY_KIND[error.kind],
    );
  }
  console.error('NocoProject request failed.', error);
  return context.json(
    errorBody('INTERNAL_ERROR', 'Internal server error.'),
    500,
  );
};

/** A router whose handler errors go through `npErrorHandler`. */
export function npRouter<E extends Env = Env>(): Hono<E> {
  const router = new Hono<E>();
  router.onError(npErrorHandler);
  return router;
}

/** Wraps route modules behind the given middleware, in a router of its own mounted by the caller. */
export function guarded<E extends Env>(
  middleware: readonly MiddlewareHandler[],
  ...routers: Hono<E>[]
): Hono<E> {
  const wrapper = npRouter<E>();
  wrapper.use('*', ...middleware);
  for (const router of routers) wrapper.route('/', router);
  return wrapper;
}

export async function readJson<T>(context: Context): Promise<T> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new NpError('invalid', 'INVALID_JSON', 'Request body must be JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new NpError(
      'invalid',
      'INVALID_JSON',
      'Request body must be a JSON object.',
    );
  }
  return body as T;
}

/** Bearer run token from the Authorization header, if one is presented. */
export function bearerRunToken(context: Context): string | null {
  const header = context.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  const token = match?.[1] ?? '';
  return token.startsWith(RUN_TOKEN_PREFIX) ? token : null;
}

/**
 * Run tokens are only valid on the agent API (protocol.md §5). A request that presents one anywhere else is refused
 * with 403 before any session lookup, so a leaked run token cannot reach the browser or daemon surface.
 */
export function rejectRunTokens(): MiddlewareHandler {
  return async (context, next) => {
    if (bearerRunToken(context)) {
      return context.json(
        errorBody(
          'RUN_TOKEN_FORBIDDEN',
          'Run tokens are only accepted by the agent API.',
        ),
        403,
      );
    }
    await next();
  };
}

/** Header the CLI user mode sends (`nocoproject-cli/<version>`). */
export const NP_CLIENT_HEADER = 'x-np-client';
const CLI_CLIENT_PREFIX = 'nocoproject-cli/';

/**
 * How the request reached the API when it was not a browser session: an `x-api-key` request (browsers never send
 * one; `auth.required()` has already verified it) is `cli` when it names the CLI in `x-np-client`, otherwise
 * `api_key`. The header only labels the source; the actor is still the key's owner.
 */
export function requestVia(
  context: Pick<Context, 'req'> | undefined,
): ActorVia | undefined {
  const req = context?.req;
  if (!req || typeof req.header !== 'function') return undefined;
  if (!req.header('x-api-key')) return undefined;
  const client = req.header(NP_CLIENT_HEADER) ?? '';
  return client.startsWith(CLI_CLIENT_PREFIX) ? 'cli' : 'api_key';
}

/** The signed-in user as an actor, with `via` for API-key requests. Only valid behind `auth.required()`. */
export function sessionActor(
  context: Pick<Context<AuthEnv>, 'get'> & Partial<Pick<Context, 'req'>>,
): Actor {
  const auth = context.get('auth');
  if (!auth)
    throw new NpError(
      'unauthorized',
      'UNAUTHORIZED',
      'Authentication required',
    );
  const via = requestVia(context as Pick<Context, 'req'>);
  return via
    ? { type: 'user', id: auth.user.id, via }
    : { type: 'user', id: auth.user.id };
}

export function sessionUserId(context: Pick<Context<AuthEnv>, 'get'>): string {
  return sessionActor(context).id as string;
}

export function queryText(context: Context, name: string): string | null {
  const value = context.req.query(name);
  return value === undefined || value === '' ? null : value;
}

export function queryInt(context: Context, name: string): number | null {
  const value = queryText(context, name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new NpError(
      'invalid',
      'INVALID_QUERY',
      `${name} must be an integer.`,
    );
  return parsed;
}

/** Public URL of this application for payloads sent to daemons. */
export function serverUrlOf(
  context: Context,
  publicBasePath: string | undefined,
): string {
  const origin = new URL(context.req.url).origin;
  const base = (publicBasePath ?? '').replace(/\/+$/u, '');
  return `${origin}${base}`;
}
