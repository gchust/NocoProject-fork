/**
 * Hardens personal API keys and keeps computer credentials out of the self-service key endpoints (NP-150), as the
 * API Keys plugin documentation recommends. Registered in `server/config/auth.ts` before `apiKey()`, so its hooks run
 * before that plugin turns an `x-api-key` header into a session.
 *
 * - A request carrying `x-api-key` may not mint keys (`/api-key/create`) or read sessions (`/list-sessions`): a leaked
 *   key must not be able to make itself permanent or reach session tokens. The check is on the header, not on the
 *   resolved session.
 * - Public `/api-key/*` requests never act on the `np-computer` configuration (computer credentials are managed only
 *   through `/np/computers`), and a list without a configuration lists personal keys only.
 *
 * Trusted server calls (`Auth.pluginApi`) carry no request headers and pass untouched.
 */
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';

export const COMPUTER_KEY_CONFIG_ID = 'np-computer';
export const API_KEY_HEADER = 'x-api-key';

const KEY_FORBIDDEN_PATHS = new Set(['/api-key/create', '/list-sessions']);

interface HookContext {
  readonly path?: string;
  readonly headers?: Headers;
  readonly body?: unknown;
  readonly query?: Record<string, unknown>;
}

function configIdOf(context: HookContext): unknown {
  const body = context.body as { configId?: unknown } | undefined;
  return body?.configId ?? context.query?.configId;
}

export function npApiKeyGuard(): BetterAuthPlugin {
  return {
    id: 'np-api-key-guard',
    hooks: {
      before: [
        {
          matcher: (context: HookContext) =>
            !!context.headers &&
            !!context.path &&
            (KEY_FORBIDDEN_PATHS.has(context.path) ||
              context.path.startsWith('/api-key/')),
          handler: createAuthMiddleware(async (context) => {
            const path = context.path;
            if (
              KEY_FORBIDDEN_PATHS.has(path) &&
              context.headers?.has(API_KEY_HEADER)
            )
              throw new APIError('FORBIDDEN', {
                code: 'API_KEY_FORBIDDEN_ACTION',
                message: `An API key cannot call ${path}; sign in instead.`,
              });
            if (!path.startsWith('/api-key/')) return;
            if (configIdOf(context) === COMPUTER_KEY_CONFIG_ID)
              throw new APIError('FORBIDDEN', {
                code: 'COMPUTER_KEY_MANAGED',
                message:
                  'Computer credentials are managed on the runtimes page.',
              });
            if (path === '/api-key/list' && context.query?.configId == null)
              return {
                context: { query: { ...context.query, configId: 'default' } },
              };
          }),
        },
      ],
    },
  };
}
