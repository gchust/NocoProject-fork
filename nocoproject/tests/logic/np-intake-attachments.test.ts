// @vitest-environment node
/**
 * NP-78: AI 整理 reads the attached files. On a real PostgreSQL with the real extractor over the fixtures and a fake
 * model: the description and every readable file reach the model (unreadable ones by name), the description may be
 * empty when a file is readable, the read status is kept with the batch, the files are checked to be the caller's
 * own before anything is read, and without the AI an empty description yields one draft named after the file.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAiIntakeParser,
  type AiAgentFactory,
  type IntakeAiResponse,
} from '../../server/modules/intake/ai-parser.ts';
import { createAttachmentTextReader } from '../../server/modules/intake/attachment-text.ts';
import type { NpServices } from '../../server/modules/services.ts';
import {
  ALICE,
  BOB,
  buildServices,
  openNpTestDatabase,
  resetData,
  setRole,
  type NpTestDatabase,
  type NpTestOptions,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_intake_files');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-intake-attachments] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/attachments');
const reader = createAttachmentTextReader(
  async (_disk, key) => readFileSync(path.join(FIXTURES, key)),
  { perFileChars: 16 },
);

let services: NpServices;
let messages: string[];

const ANSWER: IntakeAiResponse = {
  drafts: [{ position: 1, parentPosition: null, title: 'SMS login' }],
};

function factory(answer: () => Promise<IntakeAiResponse>): AiAgentFactory {
  return {
    createSession: vi.fn(async () => 'session-1'),
    createAgent: vi.fn(async () => ({
      invoke: async (request) => {
        messages.push(request.userMessages[0]?.content ?? '');
        return { structuredResponse: await answer() };
      },
    })),
  };
}

async function setup(options: NpTestOptions = {}) {
  await resetData(db!);
  messages = [];
  services = buildServices(db!.database, {
    attachmentText: reader,
    ...options,
  }).services;
  await setRole(db!, ALICE, 'owner');
  await setRole(db!, BOB, 'member');
}

/** An unattached upload of `uploader` whose stored key is a fixture file. */
/** Uploads are listed by time, then by (random) id: give each one its own millisecond so the order is the upload order. */
let lastUploadAt = 0;

async function upload(uploader: string, fixture: string): Promise<string> {
  const id = randomUUID();
  const ext = fixture.split('.').pop() ?? '';
  lastUploadAt = Math.max(Date.now(), lastUploadAt + 1);
  const createdAt = new Date(lastUploadAt);
  await db!.knex.raw(
    `INSERT INTO "${db!.schema}".np_files
       (id, disk, key, filename, ext, mime_type, size, uploaded_by_id, created_at, updated_at)
     VALUES (?, 'local', ?, ?, ?, 'application/octet-stream', 1, ?, ?, ?)`,
    [id, fixture, fixture, ext, uploader, createdAt, createdAt],
  );
  return id;
}

describe.skipIf(!db)('AI 整理 reads attachments (PostgreSQL)', () => {
  beforeEach(async () =>
    setup({
      aiIntake: createAiIntakeParser(factory(async () => ANSWER)),
      aiConfigured: () => true,
    }),
  );

  it('hands the description and the files to the model and keeps what was read', async () => {
    const spec = await upload(BOB.id!, 'spec.docx');
    const notes = await upload(BOB.id!, 'invoice.pdf');
    const pixel = await upload(BOB.id!, 'pixel.png');
    const created = await services.intake.create(BOB, {
      source: 'paste',
      rawContent: 'See the files',
      attachmentIds: [spec, notes, pixel],
    });
    expect(created.parser).toBe('ai');
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message).toContain('See the files');
    expect(message).toContain(
      '<attachment name="spec.docx">\n登录页需求\n支持手机号验证码登录\n</attachment>',
    );
    // Cut at 16 characters in this test.
    expect(message).toContain(
      '<attachment name="invoice.pdf" truncated="true">\nInvoice export A\n</attachment>',
    );
    expect(message).toContain(
      'Attached files that could not be read: pixel.png.',
    );
    expect(
      created.attachments.map((file) => [file.filename, file.readStatus]),
    ).toEqual([
      ['spec.docx', { state: 'read', chars: 16 }],
      ['invoice.pdf', { state: 'truncated', chars: 16 }],
      ['pixel.png', { state: 'unsupported', chars: 0 }],
    ]);
    // Reopening the batch shows the same.
    const again = await services.intake.get(BOB, created.batch.id);
    expect(again.attachments.map((file) => file.readStatus?.state)).toEqual([
      'read',
      'truncated',
      'unsupported',
    ]);
  });

  it('parses files alone, but needs text when no file can be read', async () => {
    const spec = await upload(BOB.id!, 'spec.docx');
    const created = await services.intake.create(BOB, {
      source: 'paste',
      rawContent: '',
      attachmentIds: [spec],
    });
    expect(created.drafts.map((draft) => draft.fields.title)).toEqual([
      'SMS login',
    ]);
    expect(messages[0]).toContain('<attachment name="spec.docx">');
    const pixel = await upload(BOB.id!, 'pixel.png');
    await expect(
      services.intake.create(BOB, {
        source: 'paste',
        rawContent: '  ',
        attachmentIds: [pixel],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
  });

  it('reads nothing of files that are not the caller’s own', async () => {
    const theirs = await upload(ALICE.id!, 'spec.docx');
    await expect(
      services.intake.create(BOB, {
        source: 'paste',
        rawContent: 'mine',
        attachmentIds: [theirs],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    expect(messages).toEqual([]);
  });

  it('without the AI, splits only the description, or names one draft after the file', async () => {
    await setup({ aiConfigured: () => false });
    const spec = await upload(BOB.id!, 'notes.md');
    const withText = await services.intake.create(BOB, {
      source: 'paste',
      rawContent: '- Only this',
      attachmentIds: [spec],
    });
    expect(withText.parser).toBe('heuristic');
    expect(withText.drafts.map((draft) => draft.fields.title)).toEqual([
      'Only this',
    ]);
    const other = await upload(BOB.id!, 'spec.docx');
    const alone = await services.intake.create(BOB, {
      source: 'paste',
      rawContent: '',
      attachmentIds: [other],
    });
    expect(alone.drafts).toMatchObject([
      {
        position: 1,
        parentPosition: null,
        fields: { title: 'spec.docx', attachmentIds: [other] },
      },
    ]);
  });
});
