// @vitest-environment node
/**
 * The whole application (isolated SQLite, real authentication and authorization plugins): a freshly registered normal
 * user holds the NocoProject page grants through the default `member` permission set (seed
 * 2026092800003_np_member_page_grants), can call `/np/issues`, is bootstrapped as a plain member (the first user is
 * the owner), cannot change roles, cannot see a private project it is not a member of, and keeps its own inbox chime
 * preference (NP-108).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Client {
  get(url: string): Promise<Response>;
  send(method: string, url: string, body?: unknown): Promise<Response>;
}

/**
 * Reads use the session cookie; writes use an API key of the same user, because cookie-authenticated writes need a
 * trusted Origin that an in-process request cannot present (the daemon test does the same).
 */
async function client(
  app: StandaloneServer,
  signIn: Response,
): Promise<Client> {
  const base = `http://localhost${app.application.publicBasePath}/api`;
  const cookie = cookiesOf(signIn);
  const created = await app.fetch(
    new Request(`${base}/auth/api-key/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'np-members-test' }),
    }),
  );
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  return {
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

describe('NocoProject members through the application', () => {
  it('lets a newly registered normal user open the pages and call /np/issues', async () => {
    const app = await startNpApp(cleanups, 'nocoproject-members-');

    const adminSignIn = await post(app, '/auth/sign-in/username', {
      username: 'nocobase',
      password: 'admin123',
    });
    expect(adminSignIn.status).toBe(200);
    const admin = await client(app, adminSignIn);
    // First contact bootstraps the administrator as the NocoProject owner.
    const adminMe = await admin.get('/np/me');
    const { data: adminIdentity } = (await adminMe.json()) as {
      data: { userId: string };
    };

    const signUp = await post(app, '/auth/sign-up/email', {
      email: 'member1@example.com',
      password: 'Member-pass-1234',
      name: 'Member One',
    });
    expect(signUp.status).toBe(200);
    const memberSignIn = await post(app, '/auth/sign-in/email', {
      email: 'member1@example.com',
      password: 'Member-pass-1234',
    });
    expect(memberSignIn.status).toBe(200);
    const member = await client(app, memberSignIn);

    const permissions = await member.get('/authz/permissions');
    expect(permissions.status).toBe(200);
    const { data: snapshot } = (await permissions.json()) as {
      data: {
        unrestricted: boolean;
        permissions: {
          resource: { type: string; id: string };
          actions: string[];
        }[];
      };
    };
    expect(snapshot.unrestricted).toBe(false);
    for (const page of [
      'np-issues',
      'np-agents',
      'np-runtimes',
      'np-inbox',
      'np-projects',
      // Iteration 3 (seed 2026093000002_np_iter3_page_grants).
      'np-my-issues',
      'np-knowledge',
      'np-reports',
      'np-config',
    ]) {
      expect(snapshot.permissions).toContainEqual(
        expect.objectContaining({
          resource: { type: 'page', id: page },
          actions: expect.arrayContaining(['access']),
        }),
      );
    }
    // Iteration 3: the NocoProject settings items are no longer registered (settings live in `/config`).
    expect(snapshot.permissions).not.toContainEqual(
      expect.objectContaining({
        resource: { type: 'settings', id: 'np-members' },
      }),
    );

    const issues = await member.get('/np/issues');
    expect(issues.status).toBe(200);
    await expect(issues.json()).resolves.toEqual({
      data: [],
      nextCursor: null,
    });

    const members = (await (await member.get('/np/members')).json()) as {
      data: { userId: string; role: string; email: string | null }[];
    };
    expect(members.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: adminIdentity.userId,
          role: 'owner',
        }),
        expect.objectContaining({
          email: 'member1@example.com',
          role: 'member',
        }),
      ]),
    );

    // NP-108: the inbox chime preference is per account, on by default, and only the member's own.
    const chime = async (who: Client) =>
      (
        (await (await who.get('/np/me/preferences')).json()) as {
          data: { inboxChime: boolean };
        }
      ).data.inboxChime;
    expect(await chime(member)).toBe(true);
    const muted = await member.send('PATCH', '/np/me/preferences', {
      inboxChime: false,
    });
    expect(muted.status).toBe(200);
    await expect(muted.json()).resolves.toEqual({
      data: { inboxChime: false },
    });
    expect(await chime(member)).toBe(false);
    expect(await chime(admin)).toBe(true);
    const bad = await member.send('PATCH', '/np/me/preferences', {
      inboxChime: 'no',
    });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({
      code: 'INVALID_PREFERENCES',
    });

    const demote = await member.send(
      'PATCH',
      `/np/members/${adminIdentity.userId}`,
      {
        role: 'member',
      },
    );
    expect(demote.status).toBe(403);
    await expect(demote.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });

    // A private project and its issues stay invisible to a non-member.
    const project = await admin.send('POST', '/np/projects', {
      name: 'Secret',
      visibility: 'members',
    });
    expect(project.status).toBe(201);
    const { data: projectBody } = (await project.json()) as {
      data: { id: string };
    };
    const issue = await admin.send('POST', '/np/issues', {
      title: 'Hidden',
      projectId: projectBody.id,
    });
    expect(issue.status).toBe(201);
    const { data: issueBody } = (await issue.json()) as {
      data: { identifier: string };
    };
    expect(
      (await member.get(`/np/issues/${issueBody.identifier}`)).status,
    ).toBe(404);
    expect((await member.get(`/np/projects/${projectBody.id}`)).status).toBe(
      404,
    );
    const visible = (await (await member.get('/np/projects')).json()) as {
      data: unknown[];
    };
    expect(visible.data).toEqual([]);
  });
});
