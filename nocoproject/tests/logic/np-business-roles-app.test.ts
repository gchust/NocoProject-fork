// @vitest-environment node
/**
 * NP-153 stage 2 through the whole application (isolated SQLite, real authentication, authorization and Users plugins):
 * business roles are the `np-` permission sets, managed and assigned in `/config/members` (`/np/access/*`,
 * `PUT /np/members/:userId/roles`).
 *
 * 1. The acceptance scenario: a business admin who is not root defines a read-only observer and gives it to a member in
 *    place of np-member; the member is refused closing and merging, cannot see a private project, still reads projects
 *    and issues, and the permission workspace shows the same set and assignment.
 * 2. Platform sets (`root`, `member`, any other) cannot be assigned, to others or to oneself; existing root assignments
 *    stay.
 * 3. Platform resources cannot be granted; an `np-` set that holds a platform grant is not assigned here, and editing it
 *    keeps that grant.
 * 4. The other refusals: `user` `assign-role` alone, a non-owner and np-owner, the last owner, a role still held.
 * 5. The page grants moved from `member` to the business roles.
 */
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { afterEach, describe, expect, it } from 'vitest';

import {
  data,
  effective,
  page,
  refused,
  register,
  setOf,
  signIn,
  type Grant,
  type Role,
} from './np-app-client.ts';
import { startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The read-only observer of the acceptance criteria: projects and issues viewed on NocoProject's scope, nothing else. */
const OBSERVER: Grant[] = [
  page('np-issues'),
  page('np-projects'),
  {
    resource: { type: 'composite', id: 'nocoproject.projects' },
    actions: [
      {
        action: 'view',
        policy: {
          type: 'composite',
          scopes: { projects: 'nocoproject.visible' },
        },
      },
    ],
  },
  {
    resource: { type: 'composite', id: 'nocoproject.issues' },
    actions: [
      {
        action: 'view',
        policy: {
          type: 'composite',
          scopes: { issues: 'nocoproject.visible' },
        },
      },
    ],
  },
];

/** Root and a business admin (np-admin given by the owner through `/config`), plus two members. */
async function workspace(prefix: string) {
  const app = await startNpApp(cleanups, prefix);
  const root = await signIn(app, '/auth/sign-in/username', {
    username: 'nocobase',
    password: 'admin123',
  });
  const ada = await register(app, 'ada@example.com', 'Ada');
  const mia = await register(app, 'mia@example.com', 'Mia');
  const olga = await register(app, 'olga@example.com', 'Olga');
  const promoted = await data<{ roles: string[]; role: string }>(
    await root.send('PUT', `/np/members/${ada.userId}/roles`, {
      roles: ['np-member', 'np-admin'],
    }),
    200,
  );
  expect(promoted).toMatchObject({ role: 'admin' });
  expect([...promoted.roles].sort()).toEqual(['np-admin', 'np-member']);
  return { app, root, ada, mia, olga };
}

describe('business roles in /config/members (NP-153)', () => {
  it('lets a business admin define a read-only observer that the API then enforces', async () => {
    const { app, root, ada, mia } = await workspace('np-roles-accept-');
    expect(await effective(root, ada.userId)).not.toContain('root');

    const catalog = await data<{ pages: string[] }>(
      await ada.get('/np/access/catalog'),
      200,
    );
    expect(catalog.pages).toContain('np-issues');
    const observer = await data<Role>(
      await ada.send('POST', '/np/access/roles', {
        title: 'Read-only observer',
        grants: OBSERVER,
      }),
      201,
    );
    expect(observer.key).toMatch(/^np-r-/);
    expect(observer).toMatchObject({
      title: 'Read-only observer',
      builtIn: false,
      hasForeignGrants: false,
    });

    // Something to look at: Mia's issue in a public project, and a private project she is not in.
    type Issue = { id: string; revision: number };
    const open = await data<{ id: string }>(
      await root.send('POST', '/np/projects', { name: 'Open' }),
      201,
    );
    const secret = await data<{ id: string }>(
      await root.send('POST', '/np/projects', {
        name: 'Secret',
        visibility: 'members',
      }),
      201,
    );
    const issue = await data<Issue>(
      await root.send('POST', '/np/issues', {
        title: 'Observed',
        projectId: open.id,
        ownerUserId: mia.userId,
      }),
      201,
    );
    const database =
      app.application.container.resolve<DatabaseManager>(databaseManagerToken);
    const stamp = new Date().toISOString();
    await database
      .connection()
      .query.insertInto('pullRequests')
      .values({
        id: 'pr-1',
        repo: 'acme/app',
        number: 1,
        url: 'https://github.com/acme/app/pull/1',
        createdAt: stamp,
        updatedAt: stamp,
      })
      .execute();
    await database
      .connection()
      .query.insertInto('issuePullRequests')
      .values({
        id: 'ipr-1',
        issueId: issue.id,
        pullRequestId: 'pr-1',
        linkedByType: 'user',
        linkedById: root.userId,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .execute();

    // The observer replaces np-member.
    const assigned = await data<{ roles: string[] }>(
      await ada.send('PUT', `/np/members/${mia.userId}/roles`, {
        roles: [observer.key],
      }),
      200,
    );
    expect(assigned.roles).toEqual([observer.key]);

    await refused(
      await mia.send('PATCH', `/np/issues/${issue.id}`, {
        statusKey: 'done',
        revision: issue.revision,
      }),
      403,
      'FORBIDDEN',
    );
    await refused(
      await mia.send(
        'POST',
        `/np/issues/${issue.id}/pull-requests/pr-1/merge`,
        {
          expectedHeadSha: 'abc',
        },
      ),
      403,
      'FORBIDDEN',
    );
    expect((await mia.get(`/np/projects/${secret.id}`)).status).toBe(404);
    expect((await mia.get(`/np/projects/${open.id}`)).status).toBe(200);
    expect((await mia.get(`/np/issues/${issue.id}`)).status).toBe(200);
    // No longer np-member: the member settings are closed too.
    await refused(await mia.get('/np/access/roles'), 403, 'FORBIDDEN');

    // The permission workspace shows the same set and the same assignment.
    const stored = await setOf(root, observer.key);
    expect(stored.grants).toEqual(observer.grants);
    expect(await effective(root, mia.userId)).toEqual([observer.key]);
    const roles = await data<Role[]>(await ada.get('/np/access/roles'), 200);
    expect(roles.find((role) => role.key === observer.key)).toMatchObject({
      holderIds: [mia.userId],
      holderCount: 1,
    });
    expect(roles.map((role) => role.key)).toEqual(
      expect.arrayContaining(['np-owner', 'np-admin', 'np-member']),
    );
    expect(roles.every((role) => role.key.startsWith('np-'))).toBe(true);
  });

  it('keeps platform sets and platform grants out of /config', async () => {
    const { root, ada, mia, olga } = await workspace('np-roles-platform-');

    // Platform sets are not assigned, to others or to oneself.
    for (const roles of [['root'], ['member'], ['np-member', 'users-admin']])
      await refused(
        await ada.send('PUT', `/np/members/${mia.userId}/roles`, { roles }),
        403,
        'NOT_NP_ROLE',
      );
    await refused(
      await ada.send('PUT', `/np/members/${ada.userId}/roles`, {
        roles: ['np-member', 'np-admin', 'root'],
      }),
      403,
      'NOT_NP_ROLE',
    );
    expect(await effective(root, ada.userId)).toEqual([
      'np-admin',
      'np-member',
    ]);
    // Replacing root's business roles leaves its root assignment alone.
    await data(
      await root.send('PUT', `/np/members/${root.userId}/roles`, {
        roles: ['np-member', 'np-owner', 'np-admin'],
      }),
      200,
    );
    expect(await effective(root, root.userId)).toEqual([
      'np-admin',
      'np-member',
      'np-owner',
      'root',
    ]);
    // Nor are they edited or deleted here.
    await refused(
      await ada.send('PUT', '/np/access/roles/member', { grants: [] }),
      403,
      'NOT_NP_ROLE',
    );
    await refused(
      await ada.send('DELETE', '/np/access/roles/root'),
      403,
      'NOT_NP_ROLE',
    );

    // Platform resources are not granted.
    for (const grant of [
      page('users'),
      {
        resource: { type: 'settings', id: 'workflow' },
        actions: [{ action: 'read' }],
      },
    ])
      await refused(
        await ada.send('POST', '/np/access/roles', {
          title: 'Sneaky',
          grants: [page('np-issues'), grant],
        }),
        400,
        'GRANT_NOT_ALLOWED',
      );

    // A platform administrator adds page:users to np-admin in the permission workspace.
    const admin = await data<{ key: string; title: unknown; grants: Grant[] }>(
      await root.get('/authz/permission-sets/np-admin'),
      200,
    );
    await data(
      await root.send('PUT', '/authz/permission-sets/np-admin', {
        key: admin.key,
        title: admin.title,
        grants: [...admin.grants, page('users')],
      }),
      200,
    );
    const roles = await data<Role[]>(await ada.get('/np/access/roles'), 200);
    const listed = roles.find((role) => role.key === 'np-admin')!;
    expect(listed.hasForeignGrants).toBe(true);
    expect(listed.grants).not.toContainEqual(page('users'));
    // Assigning or revoking it here would hand out page:users: 409.
    await refused(
      await ada.send('PUT', `/np/members/${olga.userId}/roles`, {
        roles: ['np-member', 'np-admin'],
      }),
      409,
      'ROLE_HAS_PLATFORM_GRANTS',
    );
    await refused(
      await ada.send('PUT', `/np/members/${ada.userId}/roles`, {
        roles: ['np-member'],
      }),
      409,
      'ROLE_HAS_PLATFORM_GRANTS',
    );
    // Editing it replaces the NocoProject grants only.
    const edited = await data<Role>(
      await ada.send('PUT', '/np/access/roles/np-admin', {
        grants: listed.grants.filter(
          (grant) => grant.resource.id !== 'np-reports',
        ),
      }),
      200,
    );
    expect(edited.grants).not.toContainEqual(page('np-reports'));
    const after = await setOf(root, 'np-admin');
    expect(after.grants).toContainEqual(page('users'));
    expect(after.grants).not.toContainEqual(page('np-reports'));
    expect(after.grants).toContainEqual(page('np-issues'));
  });

  it('refuses assign-role alone, non-owners on np-owner, the last owner and roles in use', async () => {
    const { root, ada, mia, olga } = await workspace('np-roles-refusals-');

    // A user administrator (user assign-role, no NocoProject settings action) assigns nothing here.
    await data(
      await root.send('POST', '/authz/permission-sets', {
        key: 'user-admins',
        title: 'User admins',
        grants: [
          {
            resource: { type: 'user', id: '*' },
            actions: [{ action: 'read' }, { action: 'assign-role' }],
          },
        ],
      }),
      201,
    );
    await data(
      await root.send(
        'POST',
        '/authz/permission-sets/user-admins/assignments',
        {
          subject: { type: 'user', id: olga.userId },
        },
      ),
      201,
    );
    await refused(
      await olga.send('PUT', `/np/members/${mia.userId}/roles`, {
        roles: ['np-member', 'np-admin'],
      }),
      403,
      'FORBIDDEN',
    );
    await refused(
      await olga.send('PATCH', `/np/members/${mia.userId}`, { role: 'admin' }),
      403,
      'FORBIDDEN',
    );

    // A business admin who is not an owner neither grants nor revokes np-owner.
    await refused(
      await ada.send('PUT', `/np/members/${mia.userId}/roles`, {
        roles: ['np-member', 'np-owner'],
      }),
      403,
      'FORBIDDEN',
    );
    await refused(
      await ada.send('PUT', `/np/members/${root.userId}/roles`, {
        roles: ['np-member'],
      }),
      403,
      'FORBIDDEN',
    );
    // np-owner's grants are not edited here, and no built-in role is deleted.
    await refused(
      await ada.send('PUT', '/np/access/roles/np-owner', { grants: [] }),
      403,
      'ROLE_NOT_EDITABLE',
    );
    await refused(
      await ada.send('DELETE', '/np/access/roles/np-member'),
      403,
      'ROLE_BUILT_IN',
    );

    // The last owner stays.
    await refused(
      await root.send('PUT', `/np/members/${root.userId}/roles`, {
        roles: ['np-member'],
      }),
      409,
      'LAST_OWNER',
    );

    // A role someone holds is not deleted; once nobody does, it is.
    const helper = await data<Role>(
      await ada.send('POST', '/np/access/roles', {
        title: 'Helper',
        grants: [page('np-inbox')],
      }),
      201,
    );
    await data(
      await ada.send('PUT', `/np/members/${mia.userId}/roles`, {
        roles: ['np-member', helper.key],
      }),
      200,
    );
    const inUse = await refused(
      await ada.send('DELETE', `/np/access/roles/${helper.key}`),
      409,
      'ROLE_IN_USE',
    );
    expect(inUse.details).toMatchObject({ holderIds: [mia.userId] });
    await data(
      await ada.send('PUT', `/np/members/${mia.userId}/roles`, {
        roles: ['np-member'],
      }),
      200,
    );
    expect(
      (await ada.send('DELETE', `/np/access/roles/${helper.key}`)).status,
    ).toBe(204);
    expect(
      (await root.get(`/authz/permission-sets/${helper.key}`)).status,
    ).toBe(404);

    // The older PATCH form goes through the same rules: now a business admin promotes a member.
    await data(
      await ada.send('PATCH', `/np/members/${mia.userId}`, { role: 'admin' }),
      200,
    );
    expect(await effective(root, mia.userId)).toEqual([
      'np-admin',
      'np-member',
    ]);
  });

  it('moves the NocoProject page grants from member to the business roles', async () => {
    const { app, root, mia } = await workspace('np-roles-pages-');
    const member = await setOf(root, 'member');
    const ids = member.grants.map(
      (grant) => `${grant.resource.type}:${grant.resource.id}`,
    );
    expect(ids.filter((id) => id.startsWith('page:np-'))).toEqual([]);
    for (const retired of [
      'np-members',
      'np-settings',
      'np-github',
      'np-integrations',
    ])
      expect(ids).not.toContain(`settings:${retired}`);
    expect(ids).toContain('page:api-keys');
    for (const key of ['np-member', 'np-admin', 'np-owner'])
      expect((await setOf(root, key)).grants).toEqual(
        expect.arrayContaining([
          page('np-issues'),
          page('np-config'),
          page('np-pm'),
        ]),
      );

    // What the browser session of the member may open (her own snapshot, the `authenticated` audience included).
    const opens = async (id: string) => {
      const snapshot = await data<{
        permissions: {
          resource: { type: string; id: string };
          actions: string[];
        }[];
      }>(await mia.get('/authz/permissions'), 200);
      return snapshot.permissions.some(
        (entry) =>
          entry.resource.type === 'page' &&
          entry.resource.id === id &&
          entry.actions.includes('access'),
      );
    };
    expect(await opens('np-issues')).toBe(true);
    // Without any np- role no NocoProject page opens; the API keys page still does.
    await data(
      await root.send('PUT', `/np/members/${mia.userId}/roles`, { roles: [] }),
      200,
    );
    expect(await effective(root, mia.userId)).toEqual([]);
    expect(await opens('np-issues')).toBe(false);
    expect(await opens('api-keys')).toBe(true);
    const authz = app.application.container.resolve(authorizationToken);
    expect(
      await authz
        .for({ principal: { type: 'user', id: mia.userId } })
        .can({ resource: { type: 'page', id: 'np-issues' }, action: 'access' }),
    ).toBe(false);
  });
});
