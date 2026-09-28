// @vitest-environment node
/**
 * NP-120: revising a batch's drafts by an instruction. The pure parts (merging the model's answer back onto the
 * drafts, the prompt, `from` parsing) always run; the service parts (replacing the drafts, inherited fields, state,
 * visibility, AI availability, timeout and empty answers leaving the drafts untouched, instruction limits, `aiRefine`
 * on the detail) run on real PostgreSQL with a fake agent factory.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAiIntakeParser,
  intakeRefineSystemPrompt,
  intakeRefineUserMessage,
  normalizeRefinedDrafts,
  parseAiReply,
  intakeRefineResponseSchema,
  type AiAgentFactory,
} from '../../server/modules/intake/ai-parser.ts';
import { mergeRefinedDrafts } from '../../server/modules/intake/intake.refine.ts';
import type { IntakeRefineInput } from '../../server/modules/intake/parser.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { IntakeDraftInput } from '../../server/modules/shared/protocol.ts';
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

const FILE_A = '0b8f5a2e-7a5c-4c1e-9d67-1f3f2a0c9a01';
const FILE_B = '0b8f5a2e-7a5c-4c1e-9d67-1f3f2a0c9a02';

function draft(
  position: number,
  title: string,
  extra: Partial<IntakeDraftInput> & { fields?: object } = {},
): IntakeDraftInput {
  return {
    position,
    parentPosition: extra.parentPosition ?? null,
    fields: { title, ...(extra.fields ?? {}) },
  };
}

describe('mergeRefinedDrafts', () => {
  const before = [
    draft(1, 'Login', {
      fields: {
        executor: { type: 'user', id: 'u2' },
        ownerUserId: 'u3',
        process: 'design_first',
        attachmentIds: [FILE_A],
      },
    }),
    draft(2, 'Signup', { fields: { attachmentIds: [FILE_B] } }),
    draft(3, 'Docs'),
  ];

  it('keeps what the model does not see on kept, split and rewritten drafts', () => {
    const merged = mergeRefinedDrafts(
      before,
      [
        { ...draft(1, 'Login form'), from: 1 },
        { ...draft(2, 'Login API', { parentPosition: 1 }), from: 1 },
        { ...draft(3, 'Signup'), from: 2 },
        { ...draft(4, 'Docs'), from: 3 },
        { ...draft(5, 'Changelog'), from: null },
      ],
      false,
    );
    expect(merged).toEqual([
      {
        position: 1,
        parentPosition: null,
        fields: {
          title: 'Login form',
          executor: { type: 'user', id: 'u2' },
          ownerUserId: 'u3',
          process: 'design_first',
          attachmentIds: [FILE_A],
        },
      },
      // A split keeps the executor, owner and process on every part; the files stay on the first.
      {
        position: 2,
        parentPosition: 1,
        fields: {
          title: 'Login API',
          executor: { type: 'user', id: 'u2' },
          ownerUserId: 'u3',
          process: 'design_first',
        },
      },
      {
        position: 3,
        parentPosition: null,
        fields: { title: 'Signup', attachmentIds: [FILE_B] },
      },
      { position: 4, parentPosition: null, fields: { title: 'Docs' } },
      { position: 5, parentPosition: null, fields: { title: 'Changelog' } },
    ]);
  });

  it('moves files of removed drafts to the first top-level draft and ignores unknown sources', () => {
    const merged = mergeRefinedDrafts(
      before,
      [
        { ...draft(1, 'Docs'), from: 3 },
        { ...draft(2, 'Other'), from: 42 },
      ],
      false,
    );
    expect(merged[0].fields).toEqual({
      title: 'Docs',
      attachmentIds: [FILE_A, FILE_B],
    });
    expect(merged[1].fields).toEqual({ title: 'Other' });
  });

  it('keeps a batch split from an issue flat', () => {
    const merged = mergeRefinedDrafts(
      [draft(1, 'A'), draft(2, 'B')],
      [
        { ...draft(1, 'A'), from: 1 },
        { ...draft(2, 'B', { parentPosition: 1 }), from: 2 },
      ],
      true,
    );
    expect(merged.map((item) => item.parentPosition)).toEqual([null, null]);
  });
});

describe('refine prompt and answer', () => {
  const input: IntakeRefineInput = {
    rawContent: '- Login\n- Signup',
    project: { name: 'Website', description: null },
    workflow: null,
    labels: ['auth'],
    drafts: [
      draft(1, 'Login', {
        fields: {
          description: 'Form and API',
          executor: { type: 'user', id: 'u2' },
          ownerUserId: 'u3',
          attachmentIds: [FILE_A],
        },
      }),
    ],
    instruction: 'Split login into form and API',
    attachmentNames: ['spec.pdf'],
    underIssue: false,
  };

  it('sends the source, the drafts the model may change and the instruction', () => {
    const message = intakeRefineUserMessage(input);
    expect(message).toContain('<source>\n- Login\n- Signup\n</source>');
    expect(message).toContain('spec.pdf');
    expect(message).toContain(
      '<drafts>\n[{"position":1,"parentPosition":null,"title":"Login","description":"Form and API","priority":null,"labels":[],"stage":null}]\n</drafts>',
    );
    expect(message).toContain(
      '<instruction>\nSplit login into form and API\n</instruction>',
    );
    expect(message).not.toContain('u2');
    expect(message).not.toContain(FILE_A);
    const system = intakeRefineSystemPrompt(input);
    expect(system).toContain('"from"');
    expect(system).toContain('Project: Website');
    expect(system).not.toContain('sub-tasks of one existing issue');
    expect(intakeRefineSystemPrompt({ ...input, underIssue: true })).toContain(
      'sub-tasks of one existing issue',
    );
  });

  it('reads `from` from the reply and keeps top-level stages only under an issue', () => {
    const reply = parseAiReply(
      '```json\n{"drafts":[{"position":1,"parentPosition":null,"from":1,"title":"Form","stage":1},' +
        '{"position":2,"parentPosition":null,"from":null,"title":"API","stage":2}]}\n```',
      intakeRefineResponseSchema,
    );
    expect(normalizeRefinedDrafts(reply, false)).toEqual([
      { position: 1, parentPosition: null, from: 1, fields: { title: 'Form' } },
      {
        position: 2,
        parentPosition: null,
        from: null,
        fields: { title: 'API' },
      },
    ]);
    expect(
      normalizeRefinedDrafts(reply, true).map((item) => item.fields.stage),
    ).toEqual([1, 2]);
  });
});

const opened = await openNpTestDatabase('np_t_intake_refine');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-intake-refine] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;

async function setup(options: NpTestOptions = {}) {
  await resetData(db!);
  services = buildServices(db!.database, options).services;
  await setRole(db!, ALICE, 'owner');
  await setRole(db!, BOB, 'member');
}

/** A factory whose model answers `reply` (text) and records the user messages it got. */
function fakeFactory(reply: (signal: AbortSignal) => Promise<string>) {
  const messages: string[] = [];
  const factory: AiAgentFactory = {
    createSession: vi.fn(async () => ''),
    createAgent: vi.fn(async () => ({
      invoke: async (request) => {
        messages.push(request.userMessages[0].content);
        return { message: { content: await reply(request.signal) } };
      },
    })),
  };
  return { factory, messages };
}

const REVISED = JSON.stringify({
  drafts: [
    { position: 1, parentPosition: null, from: 1, title: 'Login form' },
    { position: 2, parentPosition: 1, from: 1, title: 'Login API', stage: 1 },
  ],
});

async function paste(): Promise<string> {
  const { batch } = await services.intake.create(BOB, {
    source: 'paste',
    rawContent: '- Login\n- Docs',
  });
  return batch.id;
}

describe.skipIf(!db)('refining a batch (PostgreSQL)', () => {
  beforeEach(async () => {
    const { factory } = fakeFactory(async () => REVISED);
    await setup({
      aiIntake: createAiIntakeParser(factory),
      aiConfigured: () => true,
    });
  });

  it('replaces the drafts with the revised, validated list and keeps assigned fields', async () => {
    const { factory, messages } = fakeFactory(async () => REVISED);
    await setup({
      aiIntake: createAiIntakeParser(factory),
      aiConfigured: () => true,
    });
    const id = await paste();
    expect((await services.intake.get(BOB, id)).aiRefine).toBe(true);
    const drafts = await services.intake.refine(BOB, id, {
      instruction: 'Split login, drop docs',
      drafts: [
        draft(1, 'Login (edited)', {
          fields: {
            executor: { type: 'user', id: ALICE.id },
            process: 'design_first',
          },
        }),
        draft(2, 'Docs'),
      ],
    });
    expect(messages.at(-1)).toContain('Login (edited)');
    expect(messages.at(-1)).toContain('Split login, drop docs');
    expect(
      drafts.map((item) => [item.position, item.parentPosition, item.fields]),
    ).toEqual([
      [
        1,
        null,
        {
          title: 'Login form',
          executor: { type: 'user', id: ALICE.id },
          process: 'design_first',
        },
      ],
      [
        2,
        1,
        {
          title: 'Login API',
          stage: 1,
          executor: { type: 'user', id: ALICE.id },
          process: 'design_first',
        },
      ],
    ]);
    expect(drafts.every((item) => item.validation.errors.length === 0)).toBe(
      true,
    );
    expect((await services.intake.get(BOB, id)).drafts).toHaveLength(2);
  });

  it('checks the instruction, the drafts, the batch state and who asks', async () => {
    const id = await paste();
    const drafts = [draft(1, 'Login')];
    await expect(
      services.intake.refine(BOB, id, { instruction: '  ', drafts }),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
    await expect(
      services.intake.refine(BOB, id, {
        instruction: 'x'.repeat(2001),
        drafts,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
    await expect(
      services.intake.refine(BOB, id, { instruction: 'ok', drafts: 'no' }),
    ).rejects.toMatchObject({ code: 'INVALID_DRAFTS' });
    await setRole(db!, ALICE, 'member');
    await expect(
      services.intake.refine(ALICE, id, { instruction: 'ok', drafts }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await services.intake.cancel(BOB, id);
    await expect(
      services.intake.refine(BOB, id, { instruction: 'ok', drafts }),
    ).rejects.toMatchObject({ code: 'INTAKE_STATE_CONFLICT' });
  });

  it('refuses without AI and leaves the drafts alone on a timeout or an empty answer', async () => {
    await setup({ aiConfigured: () => false });
    let id = await paste();
    expect((await services.intake.get(BOB, id)).aiRefine).toBe(false);
    await expect(
      services.intake.refine(BOB, id, {
        instruction: 'ok',
        drafts: [draft(1, 'Login')],
      }),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', kind: 'conflict' });

    const { factory } = fakeFactory(async () => REVISED);
    await setup({
      aiIntake: createAiIntakeParser(factory),
      aiConfigured: () => true,
    });
    await services.workspaceSettings.update(ALICE, {
      intakeParser: 'heuristic',
    });
    id = await paste();
    expect((await services.intake.get(BOB, id)).aiRefine).toBe(false);
    await expect(
      services.intake.refine(BOB, id, {
        instruction: 'ok',
        drafts: [draft(1, 'Login')],
      }),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });

    const hanging = fakeFactory(() => new Promise(() => undefined));
    await setup({
      aiIntake: createAiIntakeParser(hanging.factory, 50),
      aiConfigured: () => true,
    });
    id = await paste();
    const before = (await services.intake.get(BOB, id)).drafts;
    await expect(
      services.intake.refine(BOB, id, {
        instruction: 'ok',
        drafts: [draft(1, 'Changed')],
      }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT', kind: 'timeout' });
    expect((await services.intake.get(BOB, id)).drafts).toEqual(before);

    const empty = fakeFactory(async () => '{"drafts":[]}');
    await setup({
      aiIntake: createAiIntakeParser(empty.factory),
      aiConfigured: () => true,
    });
    id = await paste();
    await expect(
      services.intake.refine(BOB, id, {
        instruction: 'ok',
        drafts: [draft(1, 'Changed')],
      }),
    ).rejects.toMatchObject({ code: 'AI_REFINE_FAILED', kind: 'upstream' });
    expect(
      (await services.intake.get(BOB, id)).drafts.map(
        (item) => item.fields.title,
      ),
    ).not.toContain('Changed');
  });
});
