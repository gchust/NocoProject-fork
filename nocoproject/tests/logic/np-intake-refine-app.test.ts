// @vitest-environment node
/**
 * NP-120 `POST /np/intake/batches/:id/refine` through the whole application (isolated SQLite, real authentication, no
 * LLM configured): anonymous 401, a bad instruction 400, and 409 `AI_UNAVAILABLE` with `aiRefine: false` on the batch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('intake refine route (whole application)', () => {
  it('guards the route and refuses without an LLM', async () => {
    const storage = mkdtempSync(path.join(tmpdir(), 'np-refine-store-'));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const app = await startNpApp(cleanups, 'nocoproject-intake-refine-', {
      storageDir: storage,
    });
    const base = `http://localhost${app.application.publicBasePath}/api`;
    const signIn = await app.fetch(
      new Request(`${base}/auth/sign-in/username`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ username: 'nocobase', password: 'admin123' }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = cookiesOf(signIn);
    const keyResponse = await app.fetch(
      new Request(`${base}/auth/api-key/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'np-refine-test' }),
      }),
    );
    const { key } = (await keyResponse.json()) as { key: string };
    const send = (
      url: string,
      body: unknown,
      headers: Record<string, string> = { 'x-api-key': key },
    ) =>
      app.fetch(
        new Request(`${base}${url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      );

    const created = await send('/np/intake/batches', {
      source: 'paste',
      rawContent: '- Login\n- Docs',
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as {
      data: { batch: { id: string }; aiRefine: boolean };
    };
    expect(data.aiRefine).toBe(false);
    const url = `/np/intake/batches/${data.batch.id}/refine`;
    const drafts = [
      { position: 1, parentPosition: null, fields: { title: 'A' } },
    ];

    expect((await send(url, { instruction: 'Merge', drafts }, {})).status).toBe(
      401,
    );
    const empty = await send(url, { instruction: '', drafts });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { code: string }).code).toBe(
      'INVALID_FIELD',
    );
    const refused = await send(url, { instruction: 'Merge', drafts });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe(
      'AI_UNAVAILABLE',
    );
    const detail = await app.fetch(
      new Request(`${base}/np/intake/batches/${data.batch.id}`, {
        headers: { cookie },
      }),
    );
    expect(
      ((await detail.json()) as { data: { aiRefine: boolean } }).data.aiRefine,
    ).toBe(false);
  });
});
