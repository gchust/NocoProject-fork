// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('changes only the signed-in member profile and password through the real authentication API', async () => {
  const app = await startNpApp(cleanups, 'np-profile-');
  const base = `http://localhost${app.application.publicBasePath}/api/auth`;
  const post = (path: string, body: unknown, cookie = '') =>
    app.fetch(
      new Request(`${base}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
          cookie,
        },
        body: JSON.stringify(body),
      }),
    );
  const session = (cookie: string) =>
    app.fetch(
      new Request(`${base}/get-session?disableCookieCache=true`, {
        headers: { cookie },
      }),
    );
  const password = 'Member-pass-1234';
  expect(
    (
      await post('sign-up/email', {
        email: 'profile@example.com',
        username: 'profile-member',
        name: 'Member',
        password,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post('sign-up/email', {
        email: 'profile@example.com',
        username: 'profile.member',
        name: 'Member',
        password,
      })
    ).status,
  ).toBe(200);
  const login = () =>
    post('sign-in/username', { username: 'profile.member', password });
  const cookie = cookiesOf(await login());
  const otherCookie = cookiesOf(await login());
  expect((await post('update-user', { name: 'Anonymous' })).status).toBe(401);
  const taken = await post('update-user', { username: 'nocobase' }, cookie);
  expect(taken.status).toBe(400);
  expect(await taken.json()).toMatchObject({
    code: 'USERNAME_IS_ALREADY_TAKEN',
  });
  const updated = await post(
    'update-user',
    { name: 'Updated Member', username: 'updated.member' },
    cookie,
  );
  expect(updated.status).toBe(200);
  expect(await (await session(cookie)).json()).toMatchObject({
    user: {
      name: 'Updated Member',
      username: 'updated.member',
      email: 'profile@example.com',
    },
  });
  const wrong = await post(
    'change-password',
    {
      currentPassword: 'wrong-password',
      newPassword: 'Changed-pass-1234',
      revokeOtherSessions: true,
    },
    cookie,
  );
  expect(wrong.status).toBe(400);
  expect(await wrong.json()).toMatchObject({ code: 'INVALID_PASSWORD' });
  const short = await post(
    'change-password',
    { currentPassword: password, newPassword: 'short' },
    cookie,
  );
  expect(await short.json()).toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
  const long = await post(
    'change-password',
    { currentPassword: password, newPassword: 'x'.repeat(129) },
    cookie,
  );
  expect(await long.json()).toMatchObject({ code: 'PASSWORD_TOO_LONG' });
  const changed = await post(
    'change-password',
    {
      currentPassword: password,
      newPassword: 'Changed-pass-1234',
      revokeOtherSessions: true,
    },
    cookie,
  );
  expect(changed.status).toBe(200);
  expect(await (await session(otherCookie)).json()).toBeNull();
  expect(await (await session(cookiesOf(changed))).json()).toMatchObject({
    user: { username: 'updated.member' },
  });
  expect(
    (await post('sign-in/username', { username: 'updated.member', password }))
      .status,
  ).toBe(401);
  expect(
    (
      await post('sign-in/username', {
        username: 'updated.member',
        password: 'Changed-pass-1234',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post('sign-in/username', {
        username: 'nocobase',
        password: 'admin123',
      })
    ).status,
  ).toBe(200);
}, 60_000);
