// @vitest-environment node
/**
 * NP-214 comment attachments through the whole application (isolated SQLite and storage, real authentication and the
 * file plugin). A run token holding `attachment.upload` uploads files of any type to `POST /np/agent/issues/:id/uploads`
 * and attaches them to its comment and to a thread reply; the agent reads them back on the comment list and through the
 * NP-111 content route. Refusals: no capability (403 `CAPABILITY_DENIED`, on the upload and on a comment with files),
 * another issue (403 `ISSUE_NOT_IN_RUN`), too large (413 `ATTACHMENT_TOO_LARGE`, by the handler and by the body
 * limit), not multipart (415), no file (400). Browser content: safe raster images inline, everything else a download,
 * always `nosniff` and the sandbox CSP; non-members 404, anonymous 401, run tokens 403. A person attaches their own
 * upload to a comment as well. The run token is minted from a configured run, as in `np-attachments-agent-app`.
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

interface Session {
  send(method: string, url: string, body?: unknown): Promise<Response>;
  upload(file: File): Promise<string>;
  /** GET on a root path such as `contentUrl` (already carrying the base path). */
  content(url: string): Promise<Response>;
}

async function signIn(
  app: StandaloneServer,
  url: string,
  body: unknown,
): Promise<Session> {
  const base = `http://localhost${app.application.publicBasePath}/api`;
  const response = await app.fetch(
    new Request(`${base}${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = cookiesOf(response);
  const created = await app.fetch(
    new Request(`${base}/auth/api-key/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'np-comment-attachments-test' }),
    }),
  );
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  // The first NocoProject request admits a newcomer as a member.
  await app.fetch(new Request(`${base}/np/me`, { headers: { cookie } }));
  return {
    send: (method, path, payload) =>
      app.fetch(
        new Request(`${base}${path}`, {
          method,
          headers: { 'x-api-key': key, 'content-type': 'application/json' },
          body: payload === undefined ? undefined : JSON.stringify(payload),
        }),
      ),
    upload: async (file) => {
      const form = new FormData();
      form.append('file', file);
      const uploaded = await app.fetch(
        new Request(`${base}/npFiles:uploadOne`, {
          method: 'POST',
          headers: { 'x-api-key': key },
          body: form,
        }),
      );
      expect(uploaded.status).toBe(200);
      return ((await uploaded.json()) as { data: { record: { id: string } } })
        .data.record.id;
    },
    content: (contentUrl) =>
      app.fetch(
        new Request(`http://localhost${contentUrl}`, { headers: { cookie } }),
      ),
  };
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}

async function error(
  response: Response,
  status: number,
): Promise<{ code: string; details?: Record<string, unknown> }> {
  expect(response.status).toBe(status);
  return (await response.json()) as {
    code: string;
    details?: Record<string, unknown>;
  };
}

interface Attached {
  id: string;
  filename: string;
  ext: string;
  mimeType: string;
  contentUrl: string;
  previewable: boolean;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX = 1024;

describe('NP-214 comment attachments through the application', () => {
  it('lets a run upload any file, attach it to comments and replies, and serves it safely', async () => {
    const storage = mkdtempSync(path.join(tmpdir(), 'np-comment-files-'));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const app = await startNpApp(cleanups, 'nocoproject-comment-files-', {
      storageDir: storage,
      config: { nocoproject: { attachmentMaxFileSize: MAX } },
    });
    const admin = await signIn(app, '/auth/sign-in/username', {
      username: 'nocobase',
      password: 'admin123',
    });
    const password = 'Member-pass-1234';
    const signUp = await app.fetch(
      new Request(
        `http://localhost${app.application.publicBasePath}/api/auth/sign-up/email`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost',
          },
          body: JSON.stringify({
            email: 'outsider@example.com',
            password,
            name: 'Outsider',
          }),
        },
      ),
    );
    expect(signUp.status).toBe(200);
    const outsider = await signIn(app, '/auth/sign-in/email', {
      email: 'outsider@example.com',
      password,
    });

    // A private project, so the outsider cannot see the issue.
    const project = await json<{ id: string }>(
      await admin.send('POST', '/np/projects', {
        name: 'Private',
        visibility: 'members',
      }),
      201,
    );
    const own = await json<{ id: string; identifier: string }>(
      await admin.send('POST', '/np/issues', {
        title: 'Verify in the browser',
        projectId: project.id,
      }),
      201,
    );
    const other = await json<{ id: string }>(
      await admin.send('POST', '/np/issues', {
        title: 'Another issue',
        projectId: project.id,
      }),
      201,
    );

    const services = app.application.container.resolve(npServicesToken);
    const registered = await json<{ runtimes: { id: string }[] }>(
      await admin.send('POST', '/np/daemon/register', {
        daemonId: 'comment-files',
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
    const capabilities = [
      'context.read',
      'comment.create',
      'issue.execute',
      'attachment.upload',
    ];
    const configured = await json<{ id: string; ownerUserId: string }>(
      await admin.send('POST', '/np/agents', {
        name: 'Screenshotter',
        instructions: 'Attach screenshots',
        provider: 'echo',
        runtimeId: registered.runtimes[0]!.id,
        capabilities,
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
    const snapshot = async (granted: string[]) =>
      services.tx
        .read()
        .query.updateTable('runs')
        .set({
          status: 'running',
          configurationSnapshot: JSON.stringify({
            configurationRevision: 1,
            capabilities: granted,
            instructions: 'Attach screenshots',
          }),
        })
        .where('id', '=', run.id)
        .execute();
    await snapshot(capabilities);
    const runToken = `npr_${'d'.repeat(40)}`;
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
    const root = `http://localhost${app.application.publicBasePath}`;
    const agent = (
      method: string,
      url: string,
      body?: BodyInit,
      headers: Record<string, string> = {},
    ) =>
      app.fetch(
        new Request(`${root}/api/np/agent${url}`, {
          method,
          headers: { authorization: `Bearer ${runToken}`, ...headers },
          body,
        }),
      );
    const agentJson = (method: string, url: string, body: unknown) =>
      agent(method, url, JSON.stringify(body), {
        'content-type': 'application/json',
      });
    const form = (file: File) => {
      const data = new FormData();
      data.append('file', file);
      return data;
    };
    const agentUpload = async (file: File, issueId = own.id) =>
      agent('POST', `/issues/${issueId}/uploads`, form(file));
    const uploaded = async (file: File) =>
      json<{ id: string; filename: string; mimeType: string; size: number }>(
        await agentUpload(file),
        201,
      );

    // Any type is accepted: an image, a log, SVG, HTML, HTML claiming to be PNG, no extension at all.
    const png = await uploaded(
      new File([PNG], 'screen shot.png', { type: 'image/png' }),
    );
    expect(png).toEqual({
      id: png.id,
      filename: 'screen shot.png',
      mimeType: 'image/png',
      size: 8,
    });
    const log = await uploaded(
      new File(['line 1\nline 2'], 'run.log', { type: 'text/plain' }),
    );
    const svg = await uploaded(
      new File(
        ['<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
        'chart.svg',
        {
          type: 'image/svg+xml',
        },
      ),
    );
    const html = await uploaded(
      new File(['<script>alert(1)</script>'], 'page.html', {
        type: 'text/html',
      }),
    );
    const disguised = await uploaded(
      new File(['<script>alert(1)</script>'], 'image.html', {
        type: 'image/png',
      }),
    );
    const bare = await uploaded(
      new File(['no extension'], 'README', { type: '' }),
    );

    // Refusals before anything is stored.
    const tooLarge = await error(
      await agentUpload(new File([new Uint8Array(MAX + 1)], 'big.bin')),
      413,
    );
    expect(tooLarge).toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
      details: { maxFileSize: MAX },
    });
    expect(
      (
        await error(
          await agentUpload(new File([new Uint8Array(200 * 1024)], 'huge.bin')),
          413,
        )
      ).code,
    ).toBe('ATTACHMENT_TOO_LARGE');
    expect(
      (
        await error(
          await agentUpload(
            new File([PNG], 'elsewhere.png', { type: 'image/png' }),
            other.id,
          ),
          403,
        )
      ).code,
    ).toBe('ISSUE_NOT_IN_RUN');
    expect(
      (
        await error(
          await agentJson('POST', `/issues/${own.id}/uploads`, { file: 'x' }),
          415,
        )
      ).code,
    ).toBe('UNSUPPORTED_MEDIA_TYPE');
    const empty = new FormData();
    empty.append('note', 'no file');
    expect(
      (
        await error(
          await agent('POST', `/issues/${own.id}/uploads`, empty),
          400,
        )
      ).code,
    ).toBe('INVALID_FILE');

    // Attach to a comment and to a thread reply.
    const comment = await json<{ id: string; attachments: Attached[] }>(
      await agentJson('POST', `/issues/${own.identifier}/comments`, {
        content: 'Screenshots and the log.',
        attachmentIds: [png.id, log.id, svg.id],
      }),
      201,
    );
    expect(comment.attachments.map((file) => file.id)).toEqual([
      png.id,
      log.id,
      svg.id,
    ]);
    const reply = await json<{ id: string; attachments: Attached[] }>(
      await agentJson('POST', `/issues/${own.id}/comments`, {
        content: 'The rest.',
        parentId: comment.id,
        attachmentIds: [html.id, disguised.id, bare.id],
      }),
      201,
    );
    expect(reply.attachments).toHaveLength(3);
    // An attached file cannot be attached again.
    expect(
      (
        await error(
          await agentJson('POST', `/issues/${own.id}/comments`, {
            content: 'Again',
            attachmentIds: [png.id],
          }),
          400,
        )
      ).code,
    ).toBe('INVALID_ATTACHMENT');

    // The agent sees the files on the comments and downloads them with the NP-111 route.
    const listed = await json<
      { id: string; attachments: { id: string; filename: string }[] }[]
    >(await agent('GET', `/issues/${own.id}/comments`));
    expect(
      listed.map((item) => [item.id, item.attachments.map((f) => f.filename)]),
    ).toEqual([
      [comment.id, ['screen shot.png', 'run.log', 'chart.svg']],
      [reply.id, ['page.html', 'image.html', 'README']],
    ]);
    const bytes = await agent(
      'GET',
      `/issues/${own.id}/attachments/${png.id}/content`,
    );
    expect(bytes.status).toBe(200);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG);
    const view = await json<{ attachments: unknown[] }>(
      await agent('GET', `/issues/${own.id}`),
    );
    expect(view.attachments).toEqual([]);

    // The browser sees them on the issue detail, with the base path, and not in the attachment area.
    const page = await json<{
      comments: { id: string; attachments: Attached[] }[];
    }>(await admin.send('GET', `/np/issues/${own.id}`));
    const files = new Map(
      page.comments.flatMap((item) => item.attachments).map((f) => [f.id, f]),
    );
    expect(files.size).toBe(6);
    expect(files.get(png.id)).toMatchObject({
      ext: 'png',
      previewable: true,
      contentUrl: `${app.application.publicBasePath}/uploads/np/${png.id}.png`,
    });
    expect(files.get(bare.id)?.contentUrl).toBe(
      `${app.application.publicBasePath}/uploads/np/${bare.id}`,
    );
    for (const id of [log.id, svg.id, html.id, disguised.id, bare.id])
      expect(files.get(id)?.previewable).toBe(false);
    expect(
      await json<unknown[]>(
        await admin.send('GET', `/np/issues/${own.id}/attachments`),
      ),
    ).toEqual([]);

    // Content: inline only for the PNG; every response is nosniff and sandboxed.
    const served = async (id: string) => {
      const response = await admin.content(files.get(id)!.contentUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe(
        "sandbox; default-src 'none'",
      );
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await response.arrayBuffer();
      return response.headers.get('content-disposition') ?? '';
    };
    expect(await served(png.id)).toBe(
      "inline; filename*=UTF-8''screen%20shot.png",
    );
    for (const id of [log.id, svg.id, html.id, disguised.id, bare.id])
      expect(await served(id)).toMatch(/^attachment; filename\*=UTF-8''/u);
    const pngUrl = files.get(png.id)!.contentUrl;
    expect((await outsider.content(pngUrl)).status).toBe(404);
    expect(
      (await app.fetch(new Request(`http://localhost${pngUrl}`))).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(`http://localhost${pngUrl}`, {
            headers: { authorization: `Bearer ${runToken}` },
          }),
        )
      ).status,
    ).toBe(403);

    // A person attaches their own upload to a comment through the browser API.
    const mine = await admin.upload(
      new File([PNG], 'mine.png', { type: 'image/png' }),
    );
    const human = await json<{ comment: { attachments: Attached[] } }>(
      await admin.send('POST', `/np/issues/${own.id}/comments`, {
        content: 'Mine too.',
        attachmentIds: [mine],
      }),
      201,
    );
    expect(human.comment.attachments).toEqual([
      expect.objectContaining({ id: mine, previewable: true }),
    ]);

    // Without the capability: the upload and a comment with files are refused, a plain comment still works.
    const pending = await uploaded(new File(['later'], 'later.txt'));
    await snapshot(['context.read', 'comment.create', 'issue.execute']);
    const denied = await error(
      await agentUpload(new File(['x'], 'x.txt')),
      403,
    );
    expect(denied).toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { capability: 'attachment.upload' },
    });
    expect(
      await error(
        await agentJson('POST', `/issues/${own.id}/comments`, {
          content: 'With a file',
          attachmentIds: [pending.id],
        }),
        403,
      ),
    ).toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { capability: 'attachment.upload' },
    });
    expect(
      (
        await agentJson('POST', `/issues/${own.id}/comments`, {
          content: 'Text only',
        })
      ).status,
    ).toBe(201);
  });
});
