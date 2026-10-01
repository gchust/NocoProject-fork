// @vitest-environment node
/**
 * NP-214 comment attachments on a real PostgreSQL (the service; uploads and content run through the whole application
 * in `np-comment-attachments-app.test.ts`): people and agent runs attach their own uploads to comments and thread
 * replies, the refusals (someone else's upload, another run's, an attached file, a batch file, an unknown id, more
 * than ten) write nothing, the comment views list the files while the issue's attachment area, the agent issue view
 * and the claim payload do not, the area cannot remove them, the capability is checked in the service too, and an
 * agent's unattached uploads are purged. `npFiles` rows are inserted the way the uploads write them.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../../server/modules/shared/activity.ts';
import type { NpServices } from '../../server/modules/services.ts';
import {
  ALICE,
  BOB,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_comment_attachments');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-comment-attachments] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database, {
    fileObjects: { remove: async () => undefined },
  }).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
});

let lastUploadAt = 0;

interface Upload {
  readonly user?: string;
  readonly run?: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly createdAt?: Date;
}

/** An unattached upload of a person (`user`) or an agent run (`run`). */
async function upload(by: Upload): Promise<string> {
  const id = randomUUID();
  const filename = by.filename ?? 'notes.txt';
  const ext = filename.includes('.') ? filename.split('.').pop()! : '';
  lastUploadAt = Math.max(Date.now(), lastUploadAt + 1);
  const at = by.createdAt ?? new Date(lastUploadAt);
  await db!.knex.raw(
    `INSERT INTO "${db!.schema}".np_files
       (id, disk, key, filename, ext, mime_type, size, uploaded_by_id, uploaded_by_run_id, issue_id, created_at,
        updated_at)
     VALUES (?, 'local', ?, ?, ?, ?, 42, ?, ?, NULL, ?, ?)`,
    [
      id,
      `objects/${id}${ext ? `.${ext}` : ''}`,
      filename,
      ext,
      by.mimeType ?? 'text/plain',
      by.user ?? null,
      by.run ?? null,
      at,
      at,
    ],
  );
  return id;
}

/** An issue executed by a configured agent, its claimed run and the agent actor of that run. */
async function agentRun(attachmentIds: string[] = []) {
  const fixture = await registerRuntime(services, ALICE);
  const agentId = await createAgent(services, ALICE, fixture.runtimeId, 'Dev');
  const issue = await services.issues.create(ALICE, {
    title: 'Take screenshots',
    executor: { type: 'agent', id: agentId },
    attachmentIds,
  });
  const { runs } = await services.claims.claim(
    ALICE.id!,
    {
      daemonId: fixture.daemonId,
      configurationProtocol: 1,
      slots: [{ runtimeId: fixture.runtimeId, free: 1 }],
    },
    'http://test/main',
  );
  const claimed = runs[0]!;
  const actor: Actor = { type: 'agent', id: agentId, runId: claimed.run.id };
  return { issue, agentId, actor, claimed };
}

describe.skipIf(!db)('comment attachments (PostgreSQL)', () => {
  it('attaches a run’s uploads to its comment and thread reply and lists them on the comment only', async () => {
    const spec = await upload({ user: ALICE.id!, filename: 'spec.txt' });
    const { issue, actor } = await agentRun([spec]);
    const shot = await upload({
      run: actor.runId!,
      filename: 'shot.png',
      mimeType: 'image/png',
    });
    const vector = await upload({
      run: actor.runId!,
      filename: 'chart.svg',
      mimeType: 'image/svg+xml',
    });
    const { comment } = await services.comments.create(actor, issue.id, {
      content: 'Screenshots attached.',
      attachmentIds: [shot, vector],
    } as never);
    expect(
      (comment as unknown as { attachments: unknown[] }).attachments,
    ).toEqual([
      {
        id: shot,
        filename: 'shot.png',
        ext: 'png',
        mimeType: 'image/png',
        size: 42,
        contentUrl: `/uploads/np/${shot}.png`,
        previewable: true,
      },
      {
        id: vector,
        filename: 'chart.svg',
        ext: 'svg',
        mimeType: 'image/svg+xml',
        size: 42,
        contentUrl: `/uploads/np/${vector}.svg`,
        previewable: false,
      },
    ]);
    const log = await upload({ run: actor.runId!, filename: 'run.log' });
    const reply = await services.comments.create(actor, issue.id, {
      content: 'And the log.',
      parentId: comment.id,
      attachmentIds: [log],
    } as never);

    const forAgent = await services.comments.listForAgent(issue.id, {});
    expect(
      forAgent.map((item) => [item.id, item.attachments.map((f) => f.id)]),
    ).toEqual([
      [comment.id, [shot, vector]],
      [reply.comment.id, [log]],
    ]);
    expect(forAgent[1]!.attachments[0]).toEqual({
      id: log,
      filename: 'run.log',
      mimeType: 'text/plain',
      size: 42,
    });
    const detail = await services.issueQueries.detail(ALICE, issue.id);
    const comments = detail.comments as unknown as {
      id: string;
      attachments: { id: string }[];
    }[];
    expect(
      comments.find((c) => c.id === reply.comment.id)?.attachments,
    ).toEqual([expect.objectContaining({ id: log, previewable: false })]);
    // The issue's attachment area and the agent issue view keep only the issue's own file.
    expect(
      (await services.attachments.list(ALICE, issue.id)).map((f) => f.id),
    ).toEqual([spec]);
    expect(
      (await services.issueQueries.forAgent(issue.id)).attachments.map(
        (f) => f.id,
      ),
    ).toEqual([spec]);
    await expect(
      services.attachments.remove(ALICE, issue.id, shot),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The comment's files are readable like the issue's, and serve the agent content route.
    expect(await services.attachments.canRead(BOB, shot)).toBe(true);
    const activity = await rows(
      db!,
      'activities',
      'issue_id = ? AND action = ?',
      [issue.id, 'comment_added'],
    );
    expect(activity.map((row) => JSON.parse(String(row.details)))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commentId: comment.id, attachmentCount: 2 }),
      ]),
    );
    expect(
      (await rows(db!, 'activities', 'action = ?', ['attachment_added']))
        .length,
    ).toBe(1);
  });

  it('refuses files that are not the caller’s own unattached uploads and writes nothing', async () => {
    const { issue, actor } = await agentRun();
    const others = await upload({ run: 'another-run' });
    const persons = await upload({ user: ALICE.id! });
    const batched = await upload({ run: actor.runId! });
    await db!.knex.raw(
      `UPDATE "${db!.schema}".np_files SET intake_batch_id = 'b1' WHERE id = ?`,
      [batched],
    );
    const used = await upload({ run: actor.runId! });
    await services.comments.create(actor, issue.id, {
      content: 'First',
      attachmentIds: [used],
    } as never);
    const before = (await rows(db!, 'comments')).length;
    for (const attachmentIds of [
      [others],
      [persons],
      [batched],
      [used],
      [randomUUID()],
      ['not-a-uuid'],
    ])
      await expect(
        services.comments.create(actor, issue.id, {
          content: 'Refused',
          attachmentIds,
        } as never),
      ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    const many = await Promise.all(
      Array.from({ length: 11 }, () => upload({ run: actor.runId! })),
    );
    await expect(
      services.comments.create(actor, issue.id, {
        content: 'Too many',
        attachmentIds: many,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
    expect((await rows(db!, 'comments')).length).toBe(before);
    expect(
      (await rows(db!, 'np_files', 'comment_id IS NOT NULL')).map(
        (row) => row.id,
      ),
    ).toEqual([used]);
  });

  it('lets a person attach their own uploads to a comment, not someone else’s', async () => {
    const issue = await services.issues.create(ALICE, { title: 'Shared' });
    const bobs = await upload({ user: BOB.id!, filename: 'photo.jpeg' });
    const alices = await upload({ user: ALICE.id! });
    await expect(
      services.comments.create(BOB, issue.id, {
        content: 'Not mine',
        attachmentIds: [alices],
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    const { comment } = await services.comments.create(BOB, issue.id, {
      content: 'Photo',
      attachmentIds: [bobs],
    } as never);
    expect(
      (comment as unknown as { attachments: unknown[] }).attachments,
    ).toEqual([expect.objectContaining({ id: bobs, previewable: false })]);
    // A comment without files lists none.
    const plain = await services.comments.create(BOB, issue.id, {
      content: 'Plain',
    });
    expect(
      (plain.comment as unknown as { attachments: unknown[] }).attachments,
    ).toEqual([]);
  });

  it('checks attachment.upload in the service and purges a run’s unattached uploads', async () => {
    const { issue, actor, agentId } = await agentRun();
    const file = await upload({
      run: actor.runId!,
      createdAt: new Date(Date.now() - 25 * 3600_000),
    });
    const stored = (await rows(db!, 'agents', 'id = ?', [agentId]))[0]!
      .capabilities;
    const capabilities = (
      typeof stored === 'string' ? JSON.parse(stored) : stored
    ) as string[];
    await db!.knex.raw(
      `UPDATE "${db!.schema}".agents SET capabilities = ? WHERE id = ?`,
      [
        JSON.stringify(capabilities.filter((c) => c !== 'attachment.upload')),
        agentId,
      ],
    );
    await expect(
      services.comments.create(actor, issue.id, {
        content: 'With a file',
        attachmentIds: [file],
      } as never),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { capability: 'attachment.upload' },
    });
    // Without files the comment still goes through.
    await services.comments.create(actor, issue.id, { content: 'Text only' });
    expect(await services.attachments.purgeOrphans(new Date())).toBe(1);
    expect(await rows(db!, 'np_files')).toEqual([]);
  });

  it('keeps comment files out of the claim payload', async () => {
    const spec = await upload({ user: ALICE.id!, filename: 'spec.txt' });
    const shot = await upload({ user: ALICE.id!, filename: 'shot.png' });
    const fixture = await registerRuntime(services, ALICE);
    const agentId = await createAgent(
      services,
      ALICE,
      fixture.runtimeId,
      'Dev',
    );
    const issue = await services.issues.create(ALICE, {
      title: 'Claimed',
      executor: { type: 'agent', id: agentId },
      attachmentIds: [spec],
    });
    await services.comments.create(ALICE, issue.id, {
      content: '/note context',
      attachmentIds: [shot],
    } as never);
    const { runs } = await services.claims.claim(
      ALICE.id!,
      {
        daemonId: fixture.daemonId,
        configurationProtocol: 1,
        slots: [{ runtimeId: fixture.runtimeId, free: 1 }],
      },
      'http://test/main',
    );
    expect(runs[0]?.issue.attachments.map((f) => f.id)).toEqual([spec]);
  });
});
