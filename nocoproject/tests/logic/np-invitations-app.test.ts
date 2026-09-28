// @vitest-environment node
/**
 * NP-88 invitations through the whole application (isolated SQLite, real authentication plugin): the management API
 * needs a session (401 anonymous, 403 for a plain member), the public endpoints need only the token, acceptance
 * creates a real account that can sign in with the chosen password and lands in the chosen project. The first case
 * leaves the `np-email` channel disabled, so the inviter gets the link back to forward (the documented fallback); the
 * second enables it against an in-process SMTP server and reads the delivered message.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';
import { startSmtpStub } from './np-smtp-stub.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function url(app: StandaloneServer, path: string): string {
  return `http://localhost${app.application.publicBasePath}/api${path}`;
}

async function post(
  app: StandaloneServer,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(url(app, path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

/** An API key for the signed-in user (cookie writes need a trusted Origin an in-process request cannot present). */
async function apiKeyOf(app: StandaloneServer, signIn: Response) {
  const created = await app.fetch(
    new Request(url(app, '/auth/api-key/create'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookiesOf(signIn),
      },
      body: JSON.stringify({ name: 'np-invitations-test' }),
    }),
  );
  expect(created.status).toBe(200);
  return ((await created.json()) as { key: string }).key;
}

describe('NocoProject invitations through the application', () => {
  it('invites by email, accepts through the public endpoints and signs in', async () => {
    const app = await startNpApp(cleanups, 'nocoproject-invitations-');

    expect(
      (await app.fetch(new Request(url(app, '/np/invitations')))).status,
    ).toBe(401);
    expect(
      (await post(app, '/np/invitations', { emails: ['x@example.com'] }))
        .status,
    ).toBe(401);

    const adminSignIn = await post(app, '/auth/sign-in/username', {
      username: 'nocobase',
      password: 'admin123',
    });
    expect(adminSignIn.status).toBe(200);
    const adminKey = { 'x-api-key': await apiKeyOf(app, adminSignIn) };
    // First contact bootstraps the administrator as the NocoProject owner.
    expect(
      (await app.fetch(new Request(url(app, '/np/me'), { headers: adminKey })))
        .status,
    ).toBe(200);

    const project = await post(
      app,
      '/np/projects',
      { name: 'Launch', visibility: 'members' },
      adminKey,
    );
    expect(project.status).toBe(201);
    const { data: projectBody } = (await project.json()) as {
      data: { id: string };
    };

    const invited = await post(
      app,
      '/np/invitations',
      { emails: ['newcomer@example.com'], projectIds: [projectBody.id] },
      adminKey,
    );
    expect(invited.status).toBe(201);
    const { data: result } = (await invited.json()) as {
      data: {
        results: {
          email: string;
          outcome: string;
          emailSent: boolean;
          inviteUrl: string;
        }[];
      };
    };
    expect(result.results[0]).toMatchObject({
      email: 'newcomer@example.com',
      outcome: 'invited',
      emailSent: false,
    });
    const inviteUrl = result.results[0]!.inviteUrl;
    expect(inviteUrl).toContain(`${app.application.publicBasePath}/invite/`);
    const token = inviteUrl.split('/invite/')[1]!;

    const lookup = await post(app, '/np/public/invitations/lookup', { token });
    expect(lookup.status).toBe(200);
    await expect(lookup.json()).resolves.toMatchObject({
      data: { email: 'newcomer@example.com', projectNames: ['Launch'] },
    });
    expect(
      (
        await post(app, '/np/public/invitations/lookup', {
          token: 'wrong-token',
        })
      ).status,
    ).toBe(404);

    const accepted = await post(app, '/np/public/invitations/accept', {
      token,
      name: 'New Comer',
      password: 'Newcomer-pass-1234',
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      data: { email: 'newcomer@example.com', existingAccount: false },
    });
    const reused = await post(app, '/np/public/invitations/accept', {
      token,
      name: 'New Comer',
      password: 'Newcomer-pass-1234',
    });
    expect(reused.status).toBe(409);
    await expect(reused.json()).resolves.toMatchObject({
      code: 'INVITATION_ACCEPTED',
    });

    const signIn = await post(app, '/auth/sign-in/email', {
      email: 'newcomer@example.com',
      password: 'Newcomer-pass-1234',
    });
    expect(signIn.status).toBe(200);
    const cookie = cookiesOf(signIn);
    const projects = (await (
      await app.fetch(
        new Request(url(app, '/np/projects'), { headers: { cookie } }),
      )
    ).json()) as { data: { id: string }[] };
    expect(projects.data.map((item) => item.id)).toEqual([projectBody.id]);

    // A plain member leads no project, so they may not invite.
    const memberKey = { 'x-api-key': await apiKeyOf(app, signIn) };
    const refused = await post(
      app,
      '/np/invitations',
      { emails: ['other@example.com'] },
      memberKey,
    );
    expect(refused.status).toBe(403);
  });

  it('sends the invitation through the np-email SMTP channel', async () => {
    const smtp = await startSmtpStub();
    cleanups.push(() => smtp.close());
    const app = await startNpApp(cleanups, 'nocoproject-invitations-smtp-', {
      config: {
        notification: {
          channels: {
            'np-email': {
              provider: 'smtp',
              enabled: true,
              host: '127.0.0.1',
              port: smtp.port,
              secure: false,
              from: 'NocoProject <noreply@example.com>',
            },
          },
        },
      },
    });
    const adminSignIn = await post(app, '/auth/sign-in/username', {
      username: 'nocobase',
      password: 'admin123',
    });
    const adminKey = { 'x-api-key': await apiKeyOf(app, adminSignIn) };
    const invited = await post(
      app,
      '/np/invitations',
      { emails: ['mailbox@example.com'] },
      adminKey,
    );
    expect(invited.status).toBe(201);
    await expect(invited.json()).resolves.toEqual({
      data: {
        results: [
          { email: 'mailbox@example.com', outcome: 'invited', emailSent: true },
        ],
      },
    });
    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message!.to).toEqual(['mailbox@example.com']);
    expect(message!.from).toBe('noreply@example.com');
    const link = /\/invite\/([A-Za-z0-9_-]{20,})/u.exec(
      message!.data.replace(/=\r?\n/gu, ''),
    );
    expect(link).not.toBeNull();
    const lookup = await post(app, '/np/public/invitations/lookup', {
      token: link![1],
    });
    expect(lookup.status).toBe(200);
  });
});
