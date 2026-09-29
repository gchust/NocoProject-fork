// @vitest-environment node
/**
 * NP-117 through the whole application (isolated SQLite, real authentication, authorization and Users plugins): member
 * roles are the built-in permission sets `np-owner` / `np-admin` / `np-member`, and the `/config` APIs check the
 * settings items `nocoproject.*`.
 *
 * - A new installation's owner is its initial administrator (root), not whoever arrives first.
 * - A newcomer holds `np-member`: reads the labels, cannot change them, the workspace settings or the GitHub connection.
 * - `np-admin` assigned in the Users page (its role-scope API) opens those writes on the next request, and projects to
 *   `admin` in `/np/members`; removing it closes them again.
 * - A business admin without the Users page's `assign-role` cannot change ordinary roles through `/np/members`.
 * - `np-owner` cannot be assigned through the permission workspace; an owner grants it through `/np/members`, and the
 *   last owner cannot give it up.
 */
import { afterEach, describe, expect, it } from 'vitest';

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

async function post(
  app: StandaloneServer,
  url: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${app.application.publicBasePath}/api${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Reads use the session cookie; writes an API key of the same user (cookie writes need a trusted Origin that an
 * in-process request cannot present).
 */
async function signIn(
  app: StandaloneServer,
  path: string,
  credentials: Record<string, string>,
): Promise<Client> {
  const session = await post(app, path, credentials);
  expect(session.status).toBe(200);
  const base = `http://localhost${app.application.publicBasePath}/api`;
  const cookie = cookiesOf(session);
  const created = await app.fetch(
    new Request(`${base}/auth/api-key/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'np-access-test' }),
    }),
  );
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  const me = await app.fetch(
    new Request(`${base}/np/me`, { headers: { cookie } }),
  );
  const { data } = (await me.json()) as { data: { userId: string } };
  return {
    userId: data.userId,
    get: (url) =>
      app.fetch(new Request(`${base}${url}`, { headers: { cookie } })),
    send: (method, url, body) =>
      app.fetch(
        new Request(`${base}${url}`, {
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
  const signUp = await post(app, '/auth/sign-up/email', {
    email,
    password,
    name,
  });
  expect(signUp.status).toBe(200);
  return signIn(app, '/auth/sign-in/email', { email, password });
}

async function roleIn(client: Client, userId: string): Promise<string> {
  const members = (await (await client.get('/np/members')).json()) as {
    data: { userId: string; role: string }[];
  };
  return members.data.find((member) => member.userId === userId)?.role ?? '';
}

async function settingsGrants(client: Client): Promise<string[]> {
  const { data } = (await (await client.get('/authz/permissions')).json()) as {
    data: {
      permissions: {
        resource: { type: string; id: string };
        actions: string[];
      }[];
    };
  };
  return data.permissions
    .filter((grant) => grant.resource.type === 'settings')
    .flatMap((grant) =>
      grant.actions.map((action) => `${grant.resource.id}/${action}`),
    )
    .sort();
}

describe('NocoProject roles and settings on the built-in authorization (NP-117)', () => {
  it('stores roles as permission sets and checks the settings items on the APIs', async () => {
    const app = await startNpApp(cleanups, 'nocoproject-access-');
    const root = await signIn(app, '/auth/sign-in/username', {
      username: 'nocobase',
      password: 'admin123',
    });
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');

    // The initial administrator is the owner; newcomers are members, whoever came first.
    expect(await roleIn(root, root.userId)).toBe('owner');
    expect(await roleIn(root, alice.userId)).toBe('member');

    const sets = (await (await root.get('/authz/permission-sets')).json()) as {
      data: { key: string; protection?: { allow?: string[] } }[];
    };
    expect(sets.data.map((set) => set.key)).toEqual(
      expect.arrayContaining(['np-member', 'np-admin', 'np-owner']),
    );
    const effective = async (userId: string) =>
      (
        (await (
          await root.get(`/authz/permission-sets/effective/user/${userId}`)
        ).json()) as { data: { key: string }[] }
      ).data
        .map((set) => set.key)
        .sort();
    expect(await effective(root.userId)).toEqual(
      expect.arrayContaining(['np-owner', 'root']),
    );
    expect(await effective(alice.userId)).toEqual(['np-member']);

    // np-member: the tabs it could read before, nothing to change.
    expect(await settingsGrants(alice)).toEqual([
      'nocoproject.general/read',
      'nocoproject.labels/read',
      'nocoproject.members/read',
      'nocoproject.workflows/read',
    ]);
    expect((await alice.get('/np/labels')).status).toBe(200);
    const denied = await alice.send('POST', '/np/labels', { name: 'Bug' });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await alice.send('PATCH', '/np/settings', { issuePrefix: 'XX' })).status,
    ).toBe(403);
    expect((await alice.get('/np/integrations/github')).status).toBe(403);
    const settings = (await (await alice.get('/np/settings')).json()) as {
      data: { canEdit: boolean };
    };
    expect(settings.data.canEdit).toBe(false);

    // The owner is unrestricted here (root) and may change labels.
    const label = await root.send('POST', '/np/labels', { name: 'Bug' });
    expect(label.status).toBe(201);

    // np-admin, assigned in the Users page, opens the writes on the next request.
    const assign = await root.send(
      'PUT',
      `/users/${alice.userId}/role-scopes/app`,
      { value: ['np-member', 'np-admin'] },
    );
    expect(assign.status).toBe(200);
    expect(await effective(alice.userId)).toEqual(['np-admin', 'np-member']);
    const created = await alice.send('POST', '/np/labels', {
      name: 'Feature',
    });
    expect(created.status).toBe(201);
    expect((await alice.get('/np/integrations/github')).status).toBe(200);
    expect(await roleIn(alice, alice.userId)).toBe('admin');

    // A business admin is not a user administrator: ordinary roles stay with the Users page.
    const promote = await alice.send('PATCH', `/np/members/${bob.userId}`, {
      role: 'admin',
    });
    expect(promote.status).toBe(403);
    expect(await effective(bob.userId)).toEqual(['np-member']);

    // Removing np-admin closes the writes again.
    const revoke = await root.send(
      'PUT',
      `/users/${alice.userId}/role-scopes/app`,
      { value: ['np-member'] },
    );
    expect(revoke.status).toBe(200);
    expect(
      (await alice.send('POST', '/np/labels', { name: 'Chore' })).status,
    ).toBe(403);
    expect(await roleIn(alice, alice.userId)).toBe('member');

    // np-owner is code-owned: the permission workspace cannot assign it.
    const generic = await root.send(
      'POST',
      '/authz/permission-sets/np-owner/assignments',
      { subject: { type: 'user', id: bob.userId } },
    );
    expect(generic.status).toBe(403);
    await expect(generic.json()).resolves.toMatchObject({
      code: 'PROTECTED_PERMISSION_SET',
    });

    // An owner grants it through /np/members; the last owner cannot give it up.
    const lastOwner = await root.send('PATCH', `/np/members/${root.userId}`, {
      role: 'member',
    });
    expect(lastOwner.status).toBe(409);
    await expect(lastOwner.json()).resolves.toMatchObject({
      code: 'LAST_OWNER',
    });
    const byMember = await bob.send('PATCH', `/np/members/${bob.userId}`, {
      role: 'owner',
    });
    expect(byMember.status).toBe(403);
    const owner = await root.send('PATCH', `/np/members/${bob.userId}`, {
      role: 'owner',
    });
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({
      data: { userId: bob.userId, role: 'owner' },
    });
    expect(await effective(bob.userId)).toEqual(['np-member', 'np-owner']);
    expect(
      (await bob.send('POST', '/np/labels', { name: 'Chore' })).status,
    ).toBe(201);

    // Two owners: one may step down. Bob is then the only one, whom neither leaving nor disabling can remove.
    const stepDown = await root.send('PATCH', `/np/members/${root.userId}`, {
      role: 'member',
    });
    expect(stepDown.status).toBe(200);
    expect(await effective(root.userId)).toEqual(['np-member', 'root']);
    expect(
      (await bob.send('PATCH', `/np/members/${bob.userId}`, { role: 'member' }))
        .status,
    ).toBe(409);
    const disable = await root.send('POST', `/users/${bob.userId}/disable`);
    expect(disable.status).toBe(409);
    expect(await effective(bob.userId)).toEqual(['np-member', 'np-owner']);
  });
});
