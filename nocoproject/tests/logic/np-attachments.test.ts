// @vitest-environment node
/**
 * NP-78 issue attachments on a real PostgreSQL (the service; the upload and content routes run through the whole
 * application in `np-attachments-app.test.ts`): attaching on create and later, the refusals (malformed id, someone
 * else's upload, an attached file, more than ten), who may remove, the private-project read rule, the agent's
 * metadata, the activities, and the orphan purge with its stored objects. `npFiles` rows are inserted the way the
 * file plugin's upload writes them.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_attachments');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-attachments] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let removed: { disk: string; key: string }[];

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  removed = [];
  services = buildServices(db.database, {
    fileObjects: {
      remove: async (disk, key) => {
        removed.push({ disk, key });
      },
    },
  }).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
});

/** An unattached upload of `uploader`, as the plugin stores it. */
/** Uploads are listed by time, then by (random) id: by default each one gets its own millisecond, in call order. */
let lastUploadAt = 0;
function nextUploadAt(): Date {
  lastUploadAt = Math.max(Date.now(), lastUploadAt + 1);
  return new Date(lastUploadAt);
}

async function upload(
  uploader: string,
  filename = 'notes.txt',
  createdAt = nextUploadAt(),
): Promise<string> {
  const id = randomUUID();
  await db!.knex.raw(
    `INSERT INTO "${db!.schema}".np_files
       (id, disk, key, filename, ext, mime_type, size, uploaded_by_id, issue_id, created_at, updated_at)
     VALUES (?, 'local', ?, ?, 'txt', 'text/plain', 1234, ?, NULL, ?, ?)`,
    [id, `objects/${id}.txt`, filename, uploader, createdAt, createdAt],
  );
  return id;
}

describe.skipIf(!db)('issue attachments (PostgreSQL)', () => {
  it('attaches own uploads on create and later, lists them and shows agents the metadata', async () => {
    const first = await upload(ALICE.id!, 'spec.txt');
    const issue = await services.issues.create(ALICE, {
      title: 'With files',
      attachmentIds: [first],
    });
    const second = await upload(BOB.id!, 'bob.txt');
    const list = await services.attachments.attach(BOB, issue.identifier, [
      second,
    ]);
    expect(list).toMatchObject([
      {
        id: first,
        filename: 'spec.txt',
        size: 1234,
        uploadedById: ALICE.id,
        contentUrl: `/uploads/np/${first}.txt`,
        canDelete: false,
      },
      { id: second, uploadedById: BOB.id, canDelete: true },
    ]);
    expect(
      (await services.attachments.list(ALICE, issue.id)).map(
        (item) => item.canDelete,
      ),
    ).toEqual([true, true]);
    expect(
      (await services.issueQueries.forAgent(issue.id)).attachments,
    ).toEqual([
      { id: first, filename: 'spec.txt', mimeType: 'text/plain', size: 1234 },
      { id: second, filename: 'bob.txt', mimeType: 'text/plain', size: 1234 },
    ]);
    const activities = await rows(db!, 'activities', 'issue_id = ?', [
      issue.id,
    ]);
    expect(activities.map((row) => row.action)).toEqual(
      expect.arrayContaining(['attachment_added']),
    );
  });

  it('refuses malformed ids, other uploads, attached files and more than ten', async () => {
    const issue = await services.issues.create(ALICE, { title: 'Target' });
    const bobs = await upload(BOB.id!);
    for (const fileIds of [['not-a-uuid'], [bobs], [randomUUID()]]) {
      await expect(
        services.attachments.attach(ALICE, issue.id, fileIds),
      ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    }
    await expect(
      services.issues.create(ALICE, { title: 'Nope', attachmentIds: [bobs] }),
    ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    // The refused create left nothing behind.
    expect(await rows(db!, 'issues', 'title = ?', ['Nope'])).toEqual([]);
    const mine = await upload(ALICE.id!);
    await services.attachments.attach(ALICE, issue.id, [mine]);
    await expect(
      services.attachments.attach(ALICE, issue.id, [mine]),
    ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    await expect(
      services.attachments.attach(
        ALICE,
        issue.id,
        Array.from({ length: 11 }, () => randomUUID()),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
  });

  it('lets the uploader, the owner and admins remove, deleting the stored object', async () => {
    const issue = await services.issues.create(BOB, { title: 'Owned by Bob' });
    const carols = await upload(CAROL.id!, 'carol.txt');
    await services.attachments.attach(CAROL, issue.id, [carols]);
    const bobs = await upload(BOB.id!, 'bob.txt');
    await services.attachments.attach(BOB, issue.id, [bobs]);

    await expect(
      services.attachments.remove(CAROL, issue.id, bobs),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.attachments.remove(CAROL, issue.id, 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await services.attachments.remove(CAROL, issue.id, carols);
    await services.attachments.remove(BOB, issue.id, bobs);
    expect(removed).toEqual([
      { disk: 'local', key: `objects/${carols}.txt` },
      { disk: 'local', key: `objects/${bobs}.txt` },
    ]);
    expect(await services.attachments.list(BOB, issue.id)).toEqual([]);
    const actions = (
      await rows(db!, 'activities', 'issue_id = ?', [issue.id])
    ).map((row) => row.action);
    expect(
      actions.filter((action) => action === 'attachment_removed'),
    ).toHaveLength(2);
  });

  it('reads a file only where its issue is visible, an unattached one only for its uploader', async () => {
    const project = await services.projects.create(BOB, {
      name: 'Secret',
      visibility: 'members',
    });
    const secret = await upload(BOB.id!);
    expect(await services.attachments.canRead(BOB, secret)).toBe(true);
    expect(await services.attachments.canRead(CAROL, secret)).toBe(false);
    const issue = await services.issues.create(BOB, {
      title: 'Hidden',
      projectId: project.id,
      attachmentIds: [secret],
    });
    expect(await services.attachments.canRead(CAROL, secret)).toBe(false);
    expect(await services.attachments.canRead(ALICE, secret)).toBe(true);
    await expect(
      services.attachments.list(CAROL, issue.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await services.attachments.canRead(BOB, 'not-a-uuid')).toBe(false);
  });

  it('purges uploads left unattached for a day, with their objects', async () => {
    const now = new Date();
    const old = await upload(
      BOB.id!,
      'old.txt',
      new Date(now.getTime() - 25 * 3600_000),
    );
    const fresh = await upload(BOB.id!, 'fresh.txt', now);
    const kept = await upload(
      BOB.id!,
      'kept.txt',
      new Date(now.getTime() - 25 * 3600_000),
    );
    const issue = await services.issues.create(BOB, { title: 'Keeps one' });
    await services.attachments.attach(BOB, issue.id, [kept]);

    expect(await services.attachments.purgeOrphans(now)).toBe(1);
    expect(removed).toEqual([{ disk: 'local', key: `objects/${old}.txt` }]);
    const left = (await rows(db!, 'np_files')).map((row) => row.id);
    expect(left.sort()).toEqual([fresh, kept].sort());
  });

  it('attaches batch files nobody assigned to the first issue, and purges those of a cancelled batch', async () => {
    const loose = await upload(ALICE.id!, 'loose.txt');
    const batch = await services.intake.create(ALICE, {
      source: 'paste',
      rawContent: '- First\n- Second',
      attachmentIds: [loose],
    });
    // The member takes the file off every draft (or deletes the draft that held it).
    await services.intake.putDrafts(
      ALICE,
      batch.batch.id,
      batch.drafts.map(({ position, parentPosition, fields }) => ({
        position,
        parentPosition,
        fields: { ...fields, attachmentIds: [] },
      })),
    );
    const { issues } = await services.intake.confirm(ALICE, batch.batch.id, {});
    expect(
      (await services.attachments.list(ALICE, issues[0].id)).map(
        (item) => item.id,
      ),
    ).toEqual([loose]);
    expect(await services.attachments.list(ALICE, issues[1].id)).toEqual([]);

    const dropped = await upload(
      ALICE.id!,
      'dropped.txt',
      new Date(Date.now() - 25 * 3600_000),
    );
    const cancelled = await services.intake.create(ALICE, {
      source: 'paste',
      rawContent: 'Something',
      attachmentIds: [dropped],
    });
    const later = new Date(Date.now() + 1000);
    expect(await services.attachments.purgeOrphans(later)).toBe(0);
    await services.intake.cancel(ALICE, cancelled.batch.id);
    expect(await services.attachments.purgeOrphans(later)).toBe(1);
    expect(removed).toEqual([{ disk: 'local', key: `objects/${dropped}.txt` }]);
  });

  it('hands the claimed run the attachments and serves agentContent only for its files (NP-111)', async () => {
    const opened: string[] = [];
    services = buildServices(db!.database, {
      fileObjects: {
        remove: async () => undefined,
        open: async (disk, key) => {
          opened.push(`${disk}:${key}`);
          return new Blob([`bytes of ${key}`]).stream();
        },
      },
    }).services;
    const { runtimeId, daemonId } = await registerRuntime(services, ALICE);
    const agentId = await createAgent(services, ALICE, runtimeId, 'Reader', 1);
    const file = await upload(ALICE.id!, 'shot.txt');
    const issue = await services.issues.create(ALICE, {
      title: 'Read the screenshot',
      executor: { type: 'agent', id: agentId },
      attachmentIds: [file],
    });
    const { runs } = await services.claims.claim(
      ALICE.id!,
      { daemonId, configurationProtocol: 1, slots: [{ runtimeId, free: 1 }] },
      'http://test/main',
    );
    expect(runs[0]?.issue.attachments).toEqual([
      { id: file, filename: 'shot.txt', mimeType: 'text/plain', size: 1234 },
    ]);

    const content = await services.attachments.agentContent(issue.id, file);
    expect(content.file.filename).toBe('shot.txt');
    expect(await new Response(content.body).text()).toBe(
      `bytes of objects/${file}.txt`,
    );
    expect(opened).toEqual([`local:objects/${file}.txt`]);
    const other = await services.issues.create(ALICE, { title: 'Other' });
    await expect(
      services.attachments.agentContent(other.id, file),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      services.attachments.agentContent(issue.id, 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(opened).toHaveLength(1);
  });
});
