/**
 * Signed-in clients for the whole-application tests (`np-app-harness.ts`): reads with the session cookie, writes with an
 * API key of the same user, because cookie-authenticated writes need a trusted Origin that an in-process request cannot
 * present. Used by `np-business-roles-app.test.ts`.
 */
import { expect } from 'vitest';

import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf } from './np-app-harness.ts';

export interface Client {
  readonly userId: string;
  get(url: string): Promise<Response>;
  send(method: string, url: string, body?: unknown): Promise<Response>;
}

export function api(app: StandaloneServer): string {
  return `http://localhost${app.application.publicBasePath}/api`;
}

export async function post(
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
export async function signIn(
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
      body: JSON.stringify({ name: 'np-app-client' }),
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

export async function register(
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

export async function data<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}

export async function refused(
  response: Response,
  status: number,
  code: string,
): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ code });
  return body;
}

export interface Grant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: unknown }[];
}

export interface Role {
  key: string;
  title: unknown;
  builtIn: boolean;
  hasForeignGrants: boolean;
  grants: Grant[];
  holderIds: string[];
}

export const page = (id: string): Grant => ({
  resource: { type: 'page', id },
  actions: [{ action: 'access' }],
});

/** The keys of the sets a user holds, as the permission workspace lists them. */
export async function effective(
  root: Client,
  userId: string,
): Promise<string[]> {
  const sets = await data<{ key: string }[]>(
    await root.get(`/authz/permission-sets/effective/user/${userId}`),
    200,
  );
  return sets.map((set) => set.key).sort();
}

export async function setOf(
  root: Client,
  key: string,
): Promise<{ grants: Grant[] }> {
  return data(await root.get(`/authz/permission-sets/${key}`), 200);
}
