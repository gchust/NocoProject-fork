// @vitest-environment node
/**
 * NP-153 stage 1 through the whole application (isolated SQLite, real authentication and authorization plugins): the
 * business actions `nocoproject.*` are composites of the built-in authorization, and the services read their
 * three-state scope instead of the old owner/admin bypass.
 *
 * - The premise: a composite whose data scopes select `allRecords` reads as "all", NocoProject's own record access as
 *   "related", no grant as "none". The database adapter answers every collection check `conditional`, so the
 *   composite decision itself is never `permit`; "all" comes from its checks (`scopeOfDecision`).
 * - The seed gives np-owner / np-admin every action on every record and np-member the everyday actions on
 *   NocoProject's scopes, so np-member behaves as before (the other suites run unchanged).
 * - Taking an action away from np-member refuses it on the API (403, or 404 for view); giving it `allRecords` widens
 *   it; the deciders are the holders of the action on every record.
 */
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { afterEach, describe, expect, it } from 'vitest';

import { NP_BUSINESS } from '../../server/modules/shared/access.ts';
import { createBuiltinRoles } from '../../server/providers/np-authorization.ts';
import { scopeOfDecision } from '../../server/providers/np-authorization.business.ts';
import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Client {
  readonly userId: string;
  get(url: string): Promise<Response>;
  send(method: string, url: string, body?: unknown): Promise<Response>;
}

function api(app: StandaloneServer): string {
  return `http://localhost${app.application.publicBasePath}/api`;
}

async function post(
  app: StandaloneServer,
  url: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`${api(app)}${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Reads with the session cookie, writes with an API key of the same user (as `np-access-app.test.ts`). */
async function signIn(
  app: StandaloneServer,
  path: string,
  credentials: Record<string, string>,
): Promise<Client> {
  const session = await post(app, path, credentials);
  expect(session.status).toBe(200);
  const cookie = cookiesOf(session);
  const created = await app.fetch(
    new Request(`${api(app)}/auth/api-key/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'np-business-test' }),
    }),
  );
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  const me = await app.fetch(
    new Request(`${api(app)}/np/me`, { headers: { cookie } }),
  );
  const { data } = (await me.json()) as { data: { userId: string } };
  return {
    userId: data.userId,
    get: (url) =>
      app.fetch(new Request(`${api(app)}${url}`, { headers: { cookie } })),
    send: (method, url, body) =>
      app.fetch(
        new Request(`${api(app)}${url}`, {
          method,
          headers: { 'x-api-key': key, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
  };
}

async function register(
  app: StandaloneServer,
  email: string,
  name: string,
): Promise<Client> {
  const password = 'Member-pass-1234';
  expect(
    (await post(app, '/auth/sign-up/email', { email, password, name })).status,
  ).toBe(200);
  return signIn(app, '/auth/sign-in/email', { email, password });
}

async function data<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}

interface StoredGrant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: { scopes?: Record<string, string> } }[];
}

interface StoredSet {
  key: string;
  title?: unknown;
  grants: StoredGrant[];
}

/** Rewrites one set's grants through the permission workspace API, as an administrator would. */
async function editSet(
  root: Client,
  key: string,
  change: (grants: StoredGrant[]) => StoredGrant[],
): Promise<void> {
  const set = await data<StoredSet>(
    await root.get(`/authz/permission-sets/${key}`),
    200,
  );
  const saved = await root.send('PUT', `/authz/permission-sets/${key}`, {
    key: set.key,
    title: set.title,
    grants: change(set.grants),
  });
  expect(saved.status).toBe(200);
}

function compositeGrant(
  grants: StoredGrant[],
  id: string,
): StoredGrant | undefined {
  return grants.find(
    (grant) => grant.resource.type === 'composite' && grant.resource.id === id,
  );
}

describe('NocoProject business actions on the built-in authorization (NP-153)', () => {
  it('reads allRecords as all, NocoProject scopes as related and no grant as none', async () => {
    const app = await startNpApp(cleanups, 'nocoproject-business-');
    const root = await signIn(app, '/auth/sign-in/username', {
      username: 'nocobase',
      password: 'admin123',
    });
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    expect(
      (
        await root.send('PUT', `/users/${bob.userId}/role-scopes/app`, {
          value: ['np-member', 'np-admin'],
        })
      ).status,
    ).toBe(200);

    const authz = app.application.container.resolve(authorizationToken);
    const decide = (userId: string, id: string, action: string) =>
      authz
        .for({ principal: { type: 'user', id: userId } })
        .authorize({ resource: { type: 'composite', id }, action });

    // np-admin (not root): every data scope is allRecords. Not `permit` — every collection check is conditional —
    // but every check reaches every record.
    const admin = await decide(bob.userId, NP_BUSINESS.issues, 'close');
    expect(admin.effect).toBe('conditional');
    expect(scopeOfDecision(admin)).toBe('all');
    // Root is unrestricted: the same shape.
    expect(
      scopeOfDecision(
        await decide(root.userId, NP_BUSINESS.projects, 'delete'),
      ),
    ).toBe('all');
    // np-member: NocoProject's record access, enforced by NocoProject's own rules.
    const member = await decide(alice.userId, NP_BUSINESS.issues, 'close');
    expect(member.effect).toBe('conditional');
    expect(scopeOfDecision(member)).toBe('related');
    expect(
      scopeOfDecision(
        await decide(alice.userId, NP_BUSINESS.projects, 'create'),
      ),
    ).toBe('all');
    // No grant: denied.
    const none = await decide(alice.userId, NP_BUSINESS.projects, 'delete');
    expect(none.effect).toBe('deny');
    expect(scopeOfDecision(none)).toBe('none');

    // `GET /np/me` hands the browser the same scopes, so the pages hide what the services refuse.
    const scopesOf = async (viewer: typeof alice) =>
      (
        await data<{ scopes: Record<string, string> }>(
          await viewer.get('/np/me'),
          200,
        )
      ).scopes;
    expect(await scopesOf(bob)).toMatchObject({
      'nocoproject.issues/close': 'all',
      'nocoproject.projects/delete': 'all',
    });
    expect(await scopesOf(alice)).toMatchObject({
      'nocoproject.issues/close': 'related',
      'nocoproject.projects/create': 'all',
      'nocoproject.projects/delete': 'none',
    });

    // What the seed stored.
    const memberSet = await data<StoredSet>(
      await root.get('/authz/permission-sets/np-member'),
      200,
    );
    expect(
      compositeGrant(memberSet.grants, NP_BUSINESS.issues)?.actions,
    ).toEqual(
      expect.arrayContaining([
        {
          action: 'view',
          policy: {
            type: 'composite',
            scopes: { issues: 'nocoproject.visible' },
          },
        },
      ]),
    );
    expect(
      compositeGrant(memberSet.grants, NP_BUSINESS.projects)?.actions.map(
        (entry) => entry.action,
      ),
    ).toEqual(['view', 'create', 'manage']);
    const adminSet = await data<StoredSet>(
      await root.get('/authz/permission-sets/np-admin'),
      200,
    );
    expect(
      adminSet.grants
        .find((grant) => grant.resource.id === 'nocoproject.members')
        ?.actions.map((entry) => entry.action),
    ).toEqual(['read', 'invite', 'assign', 'define-roles']);
  });

  it('refuses what a role no longer grants and widens what it grants on every record', async () => {
    const app = await startNpApp(cleanups, 'nocoproject-business-');
    const root = await signIn(app, '/auth/sign-in/username', {
      username: 'nocobase',
      password: 'admin123',
    });
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    expect(
      (
        await root.send('PUT', `/users/${bob.userId}/role-scopes/app`, {
          value: ['np-member', 'np-admin'],
        })
      ).status,
    ).toBe(200);

    const project = await data<{ id: string }>(
      await root.send('POST', '/np/projects', {
        name: 'Private',
        visibility: 'members',
      }),
      201,
    );
    const secret = await data<{ id: string }>(
      await root.send('POST', '/np/issues', {
        title: 'Secret',
        projectId: project.id,
      }),
      201,
    );
    type Issue = { id: string; revision: number };
    const mine = await data<Issue>(
      await alice.send('POST', '/np/issues', { title: 'Mine' }),
      201,
    );
    const other = await data<Issue>(
      await alice.send('POST', '/np/issues', { title: 'Other' }),
      201,
    );

    // np-member as before: private projects of others are invisible; an owner closes their own issue.
    expect((await alice.get(`/np/issues/${secret.id}`)).status).toBe(404);
    expect((await bob.get(`/np/issues/${secret.id}`)).status).toBe(200);
    await data(
      await alice.send('PATCH', `/np/issues/${other.id}`, {
        statusKey: 'cancelled',
        revision: other.revision,
      }),
      200,
    );

    // Closing taken away from np-member: 403, while editing still works.
    await editSet(root, 'np-member', (grants) =>
      grants.map((grant) =>
        grant.resource.id === NP_BUSINESS.issues
          ? {
              ...grant,
              actions: grant.actions.filter(
                (entry) => entry.action !== 'close',
              ),
            }
          : grant,
      ),
    );
    const refused = await alice.send('PATCH', `/np/issues/${mine.id}`, {
      statusKey: 'cancelled',
      revision: mine.revision,
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    const renamed = await data<Issue>(
      await alice.send('PATCH', `/np/issues/${mine.id}`, {
        title: 'Mine, renamed',
        revision: mine.revision,
      }),
      200,
    );
    // The admin keeps closing every issue.
    await data(
      await bob.send('PATCH', `/np/issues/${mine.id}`, {
        statusKey: 'cancelled',
        revision: renamed.revision,
      }),
      200,
    );

    // Viewing every issue given to np-member: the private project's issue appears.
    await editSet(root, 'np-member', (grants) =>
      grants.map((grant) =>
        grant.resource.id === NP_BUSINESS.issues
          ? {
              ...grant,
              actions: grant.actions.map((entry) =>
                entry.action === 'view'
                  ? {
                      action: 'view',
                      policy: {
                        type: 'composite',
                        scopes: { issues: 'allRecords' },
                      },
                    }
                  : entry,
              ),
            }
          : grant,
      ),
    );
    expect((await alice.get(`/np/issues/${secret.id}`)).status).toBe(200);

    // Viewing taken away altogether: every issue is 404 and the list is empty.
    await editSet(root, 'np-member', (grants) =>
      grants.map((grant) =>
        grant.resource.id === NP_BUSINESS.issues
          ? {
              ...grant,
              actions: grant.actions.filter((entry) => entry.action !== 'view'),
            }
          : grant,
      ),
    );
    expect((await alice.get(`/np/issues/${other.id}`)).status).toBe(404);
    const listed = await data<{ items?: unknown[] } | unknown[]>(
      await alice.get('/np/issues'),
      200,
    );
    expect(Array.isArray(listed) ? listed : (listed.items ?? [])).toEqual([]);

    // Deciders: whoever holds the action on every record (root and np-admin), never a plain member.
    const authz = app.application.container.resolve(authorizationToken);
    const database =
      app.application.container.resolve<DatabaseManager>(databaseManagerToken);
    const holders = await createBuiltinRoles(authz).holders(
      database.connection(),
      {
        resource: { type: 'composite', id: NP_BUSINESS.issues },
        action: 'close',
      },
    );
    expect(holders).toEqual(expect.arrayContaining([root.userId, bob.userId]));
    expect(holders).not.toContain(alice.userId);
  });
});
