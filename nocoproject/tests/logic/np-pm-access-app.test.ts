// @vitest-environment node
/**
 * NP-183 through the whole application (isolated SQLite, real authentication and authorization plugins): the access
 * the project manager acts with (`RoleAssignments.accessOf`, built without a session) is exactly the access a browser
 * request of the same member carries — the role and every business scope `GET /np/me` hands the pages — for a
 * member, an administrator and after an administrator narrows a role.
 */
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NP_BUSINESS,
  businessKey,
} from '../../server/modules/shared/access.ts';
import { createBuiltinRoles } from '../../server/providers/np-authorization.ts';
import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function api(app: StandaloneServer): string {
  return `http://localhost${app.application.publicBasePath}/api`;
}

async function post(
  app: StandaloneServer,
  url: string,
  body: unknown,
  cookie?: string,
) {
  return app.fetch(
    new Request(`${api(app)}${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

interface Session {
  readonly userId: string;
  readonly cookie: string;
}

async function signIn(
  app: StandaloneServer,
  path: string,
  credentials: Record<string, string>,
): Promise<Session> {
  const response = await post(app, path, credentials);
  expect(response.status).toBe(200);
  const cookie = cookiesOf(response);
  const me = await app.fetch(
    new Request(`${api(app)}/np/me`, { headers: { cookie } }),
  );
  const { data } = (await me.json()) as { data: { userId: string } };
  return { userId: data.userId, cookie };
}

async function register(
  app: StandaloneServer,
  email: string,
  name: string,
): Promise<Session> {
  const password = 'Member-pass-1234';
  expect(
    (await post(app, '/auth/sign-up/email', { email, password, name })).status,
  ).toBe(200);
  return signIn(app, '/auth/sign-in/email', { email, password });
}

async function browserScopes(app: StandaloneServer, session: Session) {
  const me = await app.fetch(
    new Request(`${api(app)}/np/me`, { headers: { cookie: session.cookie } }),
  );
  return ((await me.json()) as { data: { scopes: Record<string, string> } })
    .data.scopes;
}

describe('the project manager acts with the member’s own access (NP-183)', () => {
  it('builds the same role and scopes as a browser request', async () => {
    const app = await startNpApp(cleanups, 'nocoproject-pm-access-', {
      config: { app: { publicOrigin: 'http://localhost' } },
    });
    const root = await signIn(app, '/auth/sign-in/username', {
      username: 'nocobase',
      password: 'admin123',
    });
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    const assigned = await app.fetch(
      new Request(`${api(app)}/users/${bob.userId}/role-scopes/app`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
          cookie: root.cookie,
        },
        body: JSON.stringify({ value: ['np-member', 'np-admin'] }),
      }),
    );
    expect(assigned.status).toBe(200);

    const authz = app.application.container.resolve(authorizationToken);
    const roles = createBuiltinRoles(authz);
    const database = app.application.container.resolve(
      databaseManagerToken,
    ) as DatabaseManager;
    for (const session of [alice, bob, root]) {
      const access = await roles.accessOf!(session.userId);
      expect(await access.scopes()).toEqual(await browserScopes(app, session));
      expect(await access.role(database.connection())).toBe(
        await roles.roleOf(database.connection(), session.userId),
      );
    }
    const alicesScopes = await (await roles.accessOf!(alice.userId)).scopes();
    expect(alicesScopes[businessKey(NP_BUSINESS.issues, 'view')]).toBe(
      'related',
    );
    expect(alicesScopes[businessKey(NP_BUSINESS.projects, 'delete')]).toBe(
      'none',
    );
    const bobsScopes = await (await roles.accessOf!(bob.userId)).scopes();
    expect(bobsScopes[businessKey(NP_BUSINESS.issues, 'view')]).toBe('all');
  });
});
