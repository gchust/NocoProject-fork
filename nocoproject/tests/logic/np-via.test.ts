// @vitest-environment node
/**
 * Activity source (NP-86): a signed-in user acting through an API key gets `details.via` on the activities the write
 * records — `cli` when the request names the CLI user mode in `x-np-client`, `api_key` otherwise — and a browser
 * session gets none. The whole application (isolated SQLite, real authentication and API Keys plugins).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { requestVia } from '../../server/modules/shared/http.ts';
import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Activity {
  readonly action: string;
  readonly actorType: string;
  readonly details: Record<string, unknown> | null;
}

async function openSession(): Promise<{
  readonly app: StandaloneServer;
  readonly base: string;
  readonly cookie: string;
  readonly key: string;
}> {
  const app = await startNpApp(cleanups, 'nocoproject-via-');
  const base = `http://localhost${app.application.publicBasePath}/api`;
  const signIn = await app.fetch(
    new Request(`${base}/auth/sign-in/username`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nocobase', password: 'admin123' }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookie = cookiesOf(signIn);
  const created = await app.fetch(
    new Request(`${base}/auth/api-key/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'np-via-test' }),
    }),
  );
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  return { app, base, cookie, key };
}

describe('activity source of API-key requests', () => {
  it('labels CLI and other API-key writes, and leaves browser reads alone', async () => {
    const { app, base, cookie, key } = await openSession();
    const send = (
      method: string,
      url: string,
      body: unknown,
      headers: Record<string, string>,
    ) =>
      app.fetch(
        new Request(`${base}${url}`, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      );
    const activities = async (id: string): Promise<Activity[]> => {
      const response = await app.fetch(
        new Request(`${base}/np/issues/${id}/activities`, {
          headers: { cookie },
        }),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: Activity[] }).data;
    };

    const cli = { 'x-api-key': key, 'x-np-client': 'nocoproject-cli/0.3.0' };
    const created = await send(
      'POST',
      '/np/issues',
      { title: 'From CLI' },
      cli,
    );
    expect(created.status).toBe(201);
    const { data: issue } = (await created.json()) as {
      data: { id: string; revision: number };
    };
    expect(
      (
        await send(
          'POST',
          `/np/issues/${issue.id}/comments`,
          { content: 'hello from the terminal' },
          cli,
        )
      ).status,
    ).toBe(201);
    const patched = await send(
      'PATCH',
      `/np/issues/${issue.id}`,
      { statusKey: 'in_progress', revision: issue.revision },
      cli,
    );
    expect(patched.status).toBe(200);

    const cliRows = await activities(issue.id);
    expect(cliRows.length).toBeGreaterThanOrEqual(3);
    for (const row of cliRows) {
      expect(row.actorType).toBe('user');
      expect(row.details?.via).toBe('cli');
    }
    expect(cliRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['comment_added']),
    );

    const other = await send(
      'POST',
      '/np/issues',
      { title: 'From a script' },
      { 'x-api-key': key, 'x-np-client': 'my-script/1' },
    );
    expect(other.status).toBe(201);
    const { data: otherIssue } = (await other.json()) as {
      data: { id: string };
    };
    for (const row of await activities(otherIssue.id))
      expect(row.details?.via).toBe('api_key');
  });

  it('derives via from the request headers only', () => {
    const context = (headers: Record<string, string>) => ({
      req: {
        header: (name: string) => headers[name.toLowerCase()],
      },
    });
    expect(requestVia(context({}) as never)).toBeUndefined();
    expect(
      requestVia(context({ 'x-np-client': 'nocoproject-cli/0.3.0' }) as never),
    ).toBeUndefined();
    expect(requestVia(context({ 'x-api-key': 'k' }) as never)).toBe('api_key');
    expect(
      requestVia(
        context({
          'x-api-key': 'k',
          'x-np-client': 'nocoproject-cli/0.3.0',
        }) as never,
      ),
    ).toBe('cli');
    expect(requestVia(undefined)).toBeUndefined();
  });
});
