// @vitest-environment node
/**
 * NP-111 agents read issue attachments through the whole application (isolated SQLite and storage, the file plugin):
 * the agent issue view carries each attachment's `id`, and `GET /np/agent/issues/:id/attachments/:fileId/content`
 * streams the same bytes to a run token, with the name and type in the headers. Guards: no token 401, an issue outside
 * the run's project 404, a file of another issue 404, a malformed id 404. The run token is minted from a configured, claimed run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { npServicesToken } from '../../server/providers/np.ts';
import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Admin {
  send(method: string, url: string, body?: unknown): Promise<Response>;
  upload(file: File): Promise<string>;
}

/** The seeded administrator, writing with an API key (as np-attachments-app does). */
async function signInAdmin(app: StandaloneServer): Promise<Admin> {
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
  const created = await app.fetch(
    new Request(`${base}/auth/api-key/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookiesOf(signIn),
      },
      body: JSON.stringify({ name: 'np-attachments-agent-test' }),
    }),
  );
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  return {
    send: (method, url, body) =>
      app.fetch(
        new Request(`${base}${url}`, {
          method,
          headers: { 'x-api-key': key, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
    upload: async (file) => {
      const form = new FormData();
      form.append('file', file);
      const response = await app.fetch(
        new Request(`${base}/npFiles:uploadOne`, {
          method: 'POST',
          headers: { 'x-api-key': key },
          body: form,
        }),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: { record: { id: string } } })
        .data.record.id;
    },
  };
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}

describe('NP-111 agents read issue attachments', () => {
  it('lists attachment ids on the agent view and streams their bytes to the run', async () => {
    const storage = mkdtempSync(path.join(tmpdir(), 'np-attachments-agent-'));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const app = await startNpApp(cleanups, 'nocoproject-attachments-agent-', {
      storageDir: storage,
    });
    const admin = await signInAdmin(app);
    const project = async (name: string) =>
      (
        await json<{ id: string }>(
          await admin.send('POST', '/np/projects', { name }),
          201,
        )
      ).id;
    const issueWith = async (projectId: string, fileIds: string[]) =>
      json<{ id: string; identifier: string }>(
        await admin.send('POST', '/np/issues', {
          title: 'With files',
          projectId,
          attachmentIds: fileIds,
        }),
        201,
      );

    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const image = await admin.upload(
      new File([png], '截图 (1).png', { type: 'image/png' }),
    );
    const notes = await admin.upload(
      new File(['hello agent'], 'notes.txt', { type: 'text/plain' }),
    );
    const own = await issueWith(await project('Run project'), [image, notes]);
    const elsewhereFile = await admin.upload(
      new File(['secret'], 'secret.txt', { type: 'text/plain' }),
    );
    const elsewhere = await issueWith(await project('Other project'), [
      elsewhereFile,
    ]);

    const services = app.application.container.resolve(npServicesToken);
    const registered = await json<{ runtimes: { id: string }[] }>(
      await admin.send('POST', '/np/daemon/register', {
        daemonId: 'attachments',
        deviceName: 'test',
        version: '0.4.0',
        protocolVersion: 1,
        runtimes: [
          {
            provider: 'echo',
            version: '1',
            capabilities: { resume: true, steering: false },
          },
        ],
      }),
    );
    const runtimeId = registered.runtimes[0]!.id;
    const configured = await json<{ id: string; ownerUserId: string }>(
      await admin.send('POST', '/np/agents', {
        name: 'Reader',
        instructions: 'Read files',
        provider: 'echo',
        runtimeType: 'computer',
        runtimeId,
        capabilities: ['context.read', 'comment.create', 'issue.execute'],
      }),
      201,
    );
    const actor = { type: 'user', id: configured.ownerUserId } as const;
    const detail = await services.issueQueries.detail(actor, own.id);
    await services.issues.update(actor, own.id, {
      executor: { type: 'agent', id: configured.id },
      revision: detail.issue.revision,
    });
    const run = await services.tx
      .read()
      .query.selectFrom('runs')
      .selectAll()
      .where('subjectId', '=', own.id)
      .executeTakeFirstOrThrow();
    await services.tx
      .read()
      .query.updateTable('runs')
      .set({
        status: 'running',
        configurationSnapshot: JSON.stringify({
          configurationRevision: 1,
          capabilities: ['context.read'],
          instructions: 'Read files',
        }),
      })
      .where('id', '=', run.id)
      .execute();
    const runToken = `npr_${'c'.repeat(40)}`;
    vi.spyOn(services.runTokens, 'verify').mockImplementation(async (token) =>
      token === runToken
        ? {
            runId: String(run.id),
            agentId: configured.id,
            actorUserId: configured.ownerUserId,
            issueId: own.id,
          }
        : null,
    );
    const base = `http://localhost${app.application.publicBasePath}/api/np/agent`;
    const agent = (url: string, token: string | null = runToken) =>
      app.fetch(
        new Request(`${base}${url}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
      );

    const view = await json<{ attachments: unknown[] }>(
      await agent(`/issues/${own.identifier}`),
    );
    expect(view.attachments).toEqual([
      { id: image, filename: '截图 (1).png', mimeType: 'image/png', size: 8 },
      { id: notes, filename: 'notes.txt', mimeType: 'text/plain', size: 11 },
    ]);

    const bytes = await agent(
      `/issues/${own.identifier}/attachments/${image}/content`,
    );
    expect(bytes.status).toBe(200);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(png);
    expect(bytes.headers.get('content-type')).toBe('image/png');
    expect(bytes.headers.get('cache-control')).toBe('private, no-store');
    expect(bytes.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('截图 ')}%281%29.png`,
    );
    const text = await agent(`/issues/${own.id}/attachments/${notes}/content`);
    expect(await text.text()).toBe('hello agent');

    // Guards: no token, another project's issue, a file of another issue, a malformed id.
    expect(
      (await agent(`/issues/${own.id}/attachments/${notes}/content`, null))
        .status,
    ).toBe(401);
    expect(
      (
        await agent(
          `/issues/${elsewhere.id}/attachments/${elsewhereFile}/content`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await agent(`/issues/${own.id}/attachments/${elsewhereFile}/content`))
        .status,
    ).toBe(404);
    expect(
      (await agent(`/issues/${own.id}/attachments/not-a-uuid/content`)).status,
    ).toBe(404);
  });
});
