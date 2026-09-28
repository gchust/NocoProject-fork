// @vitest-environment node
/**
 * NP-78 issue attachments through the whole application (isolated SQLite and storage, real authentication and the
 * file plugin): upload through `npFiles:uploadOne`, attach on `POST /np/issues` and `POST /np/issues/:id/attachments`,
 * list, download the same bytes from `contentUrl`, remove (row and stored object), and the guards — anonymous 401,
 * run tokens 403, an unattached file only for its uploader, a private project's files 404 for non-members, someone
 * else's upload cannot be attached (400), removal only for the uploader / owner / lead / admin (403), the body
 * limit (413) and the orphan purge.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { npAttachmentServiceToken } from '../../server/providers/np.ts';
import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Session {
  readonly userId: string;
  get(url: string): Promise<Response>;
  send(method: string, url: string, body?: unknown): Promise<Response>;
  upload(file: File): Promise<Response>;
  /** GET on a root path such as `contentUrl` (already carrying the base path). */
  content(url: string): Promise<Response>;
}

interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
  uploadedById: string | null;
  canDelete: boolean;
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

/** Reads with the session cookie, writes with an API key of the same user (as np-members-app does). */
async function session(
  app: StandaloneServer,
  signIn: Response,
): Promise<Session> {
  expect(signIn.status).toBe(200);
  const base = `http://localhost${app.application.publicBasePath}/api`;
  const cookie = cookiesOf(signIn);
  const created = await app.fetch(
    new Request(`${base}/auth/api-key/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'np-attachments-test' }),
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
    upload: (file) => {
      const form = new FormData();
      form.append('file', file);
      return app.fetch(
        new Request(`${base}/npFiles:uploadOne`, {
          method: 'POST',
          headers: { 'x-api-key': key },
          body: form,
        }),
      );
    },
    content: (url) =>
      app.fetch(new Request(`http://localhost${url}`, { headers: { cookie } })),
  };
}

async function signUp(
  app: StandaloneServer,
  email: string,
  name: string,
): Promise<Session> {
  const password = 'Member-pass-1234';
  expect(
    (await post(app, '/auth/sign-up/email', { email, password, name })).status,
  ).toBe(200);
  return session(
    app,
    await post(app, '/auth/sign-in/email', { email, password }),
  );
}

async function uploaded(
  who: Session,
  name: string,
  text: string,
): Promise<{ id: string; contentUrl: string }> {
  const response = await who.upload(
    new File([text], name, { type: 'text/plain' }),
  );
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as {
    data: { record: { id: string; contentUrl: string; filename: string } };
  };
  expect(data.record.filename).toBe(name);
  return data.record;
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}

function storedObjects(storage: string): string[] {
  const dir = path.join(storage, 'objects');
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('NocoProject issue attachments through the application', () => {
  it('uploads, attaches, lists, serves, guards and removes attachments', async () => {
    const storage = mkdtempSync(path.join(tmpdir(), 'np-attachments-store-'));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const app = await startNpApp(cleanups, 'nocoproject-attachments-', {
      storageDir: storage,
      config: { nocoproject: { attachmentMaxFileSize: 1024 } },
    });
    const admin = await session(
      app,
      await post(app, '/auth/sign-in/username', {
        username: 'nocobase',
        password: 'admin123',
      }),
    );
    const member = await signUp(app, 'member1@example.com', 'Member One');
    const outsider = await signUp(app, 'member2@example.com', 'Member Two');

    // Upload: an unattached file only its uploader can read.
    const first = await uploaded(admin, 'notes.txt', 'hello attachments');
    expect(first.contentUrl).toBe(
      `${app.application.publicBasePath}/uploads/np/${first.id}.txt`,
    );
    const bytes = await admin.content(first.contentUrl);
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe('hello attachments');
    expect(bytes.headers.get('cache-control')).toBe('private, no-store');
    expect((await member.content(first.contentUrl)).status).toBe(404);
    const anonymous = await app.fetch(
      new Request(`http://localhost${first.contentUrl}`),
    );
    expect(anonymous.status).toBe(401);
    // Unknown or malformed names are 404 as well.
    expect(
      (
        await admin.content(
          `${app.application.publicBasePath}/uploads/np/00000000-0000-4000-8000-000000000000.txt`,
        )
      ).status,
    ).toBe(404);

    // Upload guards: anonymous, run token, body limit.
    const form = new FormData();
    form.append('file', new File(['x'], 'x.txt'));
    expect(
      (
        await app.fetch(
          new Request(
            `http://localhost${app.application.publicBasePath}/api/npFiles:uploadOne`,
            { method: 'POST', body: form },
          ),
        )
      ).status,
    ).toBe(401);
    const withRunToken = new FormData();
    withRunToken.append('file', new File(['x'], 'x.txt'));
    expect(
      (
        await app.fetch(
          new Request(
            `http://localhost${app.application.publicBasePath}/api/npFiles:uploadOne`,
            {
              method: 'POST',
              headers: { authorization: 'Bearer npr_not-a-real-token' },
              body: withRunToken,
            },
          ),
        )
      ).status,
    ).toBe(403);
    const tooLarge = await admin.upload(
      new File(['x'.repeat(200 * 1024)], 'big.txt', { type: 'text/plain' }),
    );
    expect(tooLarge.status).toBe(413);
    // The plugin exposes nothing else on the resource.
    expect((await admin.send('POST', '/npFiles:findMany', {})).status).toBe(
      404,
    );

    // Someone else's upload cannot be attached; nothing is created.
    const created = await admin.send('POST', '/np/issues', {
      title: 'With attachment',
      attachmentIds: [first.id],
    });
    const issue = await json<{ id: string; identifier: string }>(created, 201);
    const mine = await uploaded(member, 'member.txt', 'from member');
    const refused = await member.send(
      'POST',
      `/np/issues/${issue.id}/attachments`,
      { fileIds: [first.id] },
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe(
      'INVALID_ATTACHMENT',
    );

    // Attached: every member who can see the issue reads it.
    expect((await member.content(first.contentUrl)).status).toBe(200);
    const attached = await json<Attachment[]>(
      await member.send('POST', `/np/issues/${issue.identifier}/attachments`, {
        fileIds: [mine.id],
      }),
    );
    expect(attached.map((item) => item.filename)).toEqual([
      'notes.txt',
      'member.txt',
    ]);
    const listed = await json<Attachment[]>(
      await member.get(`/np/issues/${issue.id}/attachments`),
    );
    expect(listed).toMatchObject([
      {
        filename: 'notes.txt',
        mimeType: 'text/plain',
        size: 17,
        uploadedById: admin.userId,
        canDelete: false,
        contentUrl: first.contentUrl,
      },
      { filename: 'member.txt', uploadedById: member.userId, canDelete: true },
    ]);
    // A plain member may not remove the owner's attachment.
    expect(
      (
        await member.send(
          'DELETE',
          `/np/issues/${issue.id}/attachments/${first.id}`,
        )
      ).status,
    ).toBe(403);

    // Private project: non-members get 404 on the list and the content.
    const project = await json<{ id: string }>(
      await admin.send('POST', '/np/projects', {
        name: 'Private',
        visibility: 'members',
      }),
      201,
    );
    const secretFile = await uploaded(admin, 'secret.txt', 'secret');
    const secret = await json<{ id: string }>(
      await admin.send('POST', '/np/issues', {
        title: 'Secret',
        projectId: project.id,
        attachmentIds: [secretFile.id],
      }),
      201,
    );
    expect(
      (await outsider.get(`/np/issues/${secret.id}/attachments`)).status,
    ).toBe(404);
    expect((await outsider.content(secretFile.contentUrl)).status).toBe(404);
    expect((await admin.content(secretFile.contentUrl)).status).toBe(200);

    // Removal deletes the row and the stored object; the activity is recorded.
    const objectsBefore = storedObjects(storage).length;
    expect(
      (
        await admin.send(
          'DELETE',
          `/np/issues/${issue.id}/attachments/${first.id}`,
        )
      ).status,
    ).toBe(204);
    expect(storedObjects(storage).length).toBe(objectsBefore - 1);
    expect((await admin.content(first.contentUrl)).status).toBe(404);
    const after = await json<Attachment[]>(
      await admin.get(`/np/issues/${issue.id}/attachments`),
    );
    expect(after.map((item) => item.filename)).toEqual(['member.txt']);
    const activity = await admin.get(`/np/issues/${issue.id}/activities`);
    expect(activity.status).toBe(200);
    const text = JSON.stringify(await activity.json());
    expect(text).toContain('attachment_added');
    expect(text).toContain('attachment_removed');

    // Orphans older than a day are purged with their objects; attached files stay.
    const orphan = await uploaded(member, 'orphan.txt', 'left behind');
    const attachments = app.application.container.resolve(
      npAttachmentServiceToken,
    );
    expect(await attachments.purgeOrphans(new Date())).toBe(0);
    const purged = await attachments.purgeOrphans(
      new Date(Date.now() + 25 * 60 * 60 * 1000),
    );
    expect(purged).toBe(1);
    expect((await member.content(orphan.contentUrl)).status).toBe(404);
    expect((await member.content(mine.contentUrl)).status).toBe(200);
  });

  it('carries AI 整理 uploads with the batch and attaches them to the issues it creates', async () => {
    const storage = mkdtempSync(path.join(tmpdir(), 'np-attachments-store-'));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const app = await startNpApp(cleanups, 'nocoproject-attachments-intake-', {
      storageDir: storage,
    });
    const admin = await session(
      app,
      await post(app, '/auth/sign-in/username', {
        username: 'nocobase',
        password: 'admin123',
      }),
    );
    const member = await signUp(app, 'member1@example.com', 'Member One');
    const shot = await uploaded(admin, 'shot.txt', 'screenshot');
    const spec = await uploaded(admin, 'spec.txt', 'spec');
    const theirs = await uploaded(member, 'theirs.txt', 'not yours');

    // Someone else's upload cannot ride along; nothing is created.
    const refused = await admin.send('POST', '/np/intake/batches', {
      source: 'paste',
      rawContent: '- Fix the login page\n- Update the docs',
      attachmentIds: [theirs.id],
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe(
      'INVALID_ATTACHMENT',
    );

    interface Detail {
      batch: { id: string };
      drafts: {
        position: number;
        parentPosition: number | null;
        fields: { title: string; attachmentIds?: string[] };
      }[];
      attachments: { id: string; contentUrl: string; issueId: string | null }[];
    }
    const created = await json<Detail>(
      await admin.send('POST', '/np/intake/batches', {
        source: 'paste',
        rawContent: '- Fix the login page\n- Update the docs',
        attachmentIds: [shot.id, spec.id],
      }),
      201,
    );
    expect(created.drafts.length).toBeGreaterThanOrEqual(2);
    // Every file starts on the first draft; the batch lists them with content URLs.
    expect(created.drafts[0].fields.attachmentIds).toEqual([shot.id, spec.id]);
    expect(created.attachments.map((file) => file.contentUrl)).toEqual([
      shot.contentUrl,
      spec.contentUrl,
    ]);
    // A file in a batch cannot be attached elsewhere, and is not an orphan while the batch is open.
    const other = await json<{ id: string }>(
      await admin.send('POST', '/np/issues', { title: 'Elsewhere' }),
      201,
    );
    expect(
      (
        await admin.send('POST', `/np/issues/${other.id}/attachments`, {
          fileIds: [shot.id],
        })
      ).status,
    ).toBe(400);
    const attachments = app.application.container.resolve(
      npAttachmentServiceToken,
    );
    expect(
      await attachments.purgeOrphans(new Date(Date.now() + 25 * 3600_000)),
    ).toBe(1); // only `theirs`
    expect((await admin.content(shot.contentUrl)).status).toBe(200);

    // Move the spec to the second draft, then confirm.
    const drafts = created.drafts.map((draft, index) => ({
      position: draft.position,
      parentPosition: draft.parentPosition,
      fields: {
        ...draft.fields,
        attachmentIds:
          index === 0 ? [shot.id] : index === 1 ? [spec.id] : undefined,
      },
    }));
    expect(
      (
        await admin.send(
          'PUT',
          `/np/intake/batches/${created.batch.id}/drafts`,
          { drafts },
        )
      ).status,
    ).toBe(200);
    const confirmed = await json<{ issues: { id: string }[] }>(
      await admin.send(
        'POST',
        `/np/intake/batches/${created.batch.id}/confirm`,
        {},
      ),
    );
    const [firstIssue, secondIssue] = confirmed.issues;
    const firstFiles = await json<{ id: string }[]>(
      await admin.get(`/np/issues/${firstIssue.id}/attachments`),
    );
    const secondFiles = await json<{ id: string }[]>(
      await admin.get(`/np/issues/${secondIssue.id}/attachments`),
    );
    expect(firstFiles.map((file) => file.id)).toEqual([shot.id]);
    expect(secondFiles.map((file) => file.id)).toEqual([spec.id]);
    // Attached now: visible to members who can see the issue, and listed with its issue in the batch.
    expect((await member.content(spec.contentUrl)).status).toBe(200);
    const after = await json<Detail>(
      await admin.get(`/np/intake/batches/${created.batch.id}`),
    );
    expect(after.attachments.map((file) => file.issueId)).toEqual([
      firstIssue.id,
      secondIssue.id,
    ]);
  });

  it('reads an uploaded document for AI 整理 through the Drive-backed reader', async () => {
    const storage = mkdtempSync(path.join(tmpdir(), 'np-attachments-store-'));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const app = await startNpApp(cleanups, 'nocoproject-attachments-read-', {
      storageDir: storage,
    });
    const admin = await session(
      app,
      await post(app, '/auth/sign-in/username', {
        username: 'nocobase',
        password: 'admin123',
      }),
    );
    const bytes = readFileSync(
      path.resolve(import.meta.dirname, '../fixtures/attachments/spec.docx'),
    );
    const response = await admin.upload(
      new File([bytes], 'spec.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );
    const { data } = (await response.json()) as {
      data: { record: { id: string } };
    };
    // No LLM in this application: the rule-based parser names one draft after the file, which was still read.
    const created = await json<{
      drafts: { fields: { title: string } }[];
      attachments: { readStatus: { state: string; chars: number } | null }[];
    }>(
      await admin.send('POST', '/np/intake/batches', {
        source: 'paste',
        rawContent: '',
        attachmentIds: [data.record.id],
      }),
      201,
    );
    expect(created.drafts.map((draft) => draft.fields.title)).toEqual([
      'spec.docx',
    ]);
    expect(created.attachments[0].readStatus).toEqual({
      state: 'read',
      chars: 16,
    });
  });
});
