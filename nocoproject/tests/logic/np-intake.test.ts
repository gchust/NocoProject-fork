// @vitest-environment node
/**
 * Batch intake (iteration-2 contract §E; the pure parser rules are in `np-intake-parser.test.ts`): draft validation, confirm (parents
 * first, origin, agent executors enqueued after all issues exist, stage blocking), revert (runs keep issues), cancel,
 * splitting an issue, and the AI parser through a fake agent factory (success, failure / timeout / empty fallback,
 * the heuristic setting). Real PostgreSQL for the service parts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAiIntakeParser,
  type AiAgentFactory,
  type IntakeAiResponse,
} from '../../server/modules/intake/ai-parser.ts';
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
  runRows,
  setRole,
  type NpTestDatabase,
  type NpTestOptions,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_intake');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-intake] skipped: ${skip}`);
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

function fakeFactory(
  invoke: (
    signal: AbortSignal,
  ) => Promise<{ structuredResponse?: IntakeAiResponse }>,
) {
  const factory: AiAgentFactory = {
    createSession: vi.fn(async () => 'session-1'),
    createAgent: vi.fn(async () => ({
      invoke: async (request) => invoke(request.signal),
    })),
  };
  return factory;
}

describe.skipIf(!db)('intake batches (PostgreSQL)', () => {
  beforeEach(async () => setup());

  it('parses a paste into validated drafts and re-validates replaced drafts', async () => {
    const { batch, drafts, parser } = await services.intake.create(BOB, {
      source: 'paste',
      rawContent: '# Login\n- Form [high] #ui\n- API',
    });
    expect(parser).toBe('heuristic');
    expect(batch).toMatchObject({
      status: 'draft',
      parser: 'heuristic',
      createdById: BOB.id,
      parseError: null,
    });
    expect(drafts.map((draft) => draft.validation.errors)).toEqual([
      [],
      [],
      [],
    ]);
    const replaced = await services.intake.putDrafts(BOB, batch.id, [
      { position: 1, parentPosition: null, fields: { title: '' } },
      {
        position: 2,
        parentPosition: 3,
        fields: { title: 'x'.repeat(201), stage: 1 },
      },
      {
        position: 3,
        parentPosition: null,
        fields: { title: 'Top', stage: 2, priority: 'nope' as never },
      },
    ]);
    expect(replaced.map((draft) => draft.validation.errors)).toEqual([
      ['title is required'],
      [
        'parentPosition must point to an earlier draft',
        'title is longer than 200 characters',
      ],
      [
        'priority must be urgent, high, medium, low or none',
        'stage only applies to a sub-task',
      ],
    ]);
    await expect(
      services.intake.putDrafts(BOB, batch.id, [
        { position: 1, parentPosition: null, fields: { title: 'a' } },
        { position: 1, parentPosition: null, fields: { title: 'b' } },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_DRAFTS' });
    await expect(
      services.intake.confirm(BOB, batch.id, {}),
    ).rejects.toMatchObject({ code: 'INTAKE_INVALID' });
    await expect(services.intake.get(ALICE, batch.id)).resolves.toBeTruthy();
    await services.issues.create(ALICE, { title: 'unrelated' });
    await setRole(db!, ALICE, 'member');
    await expect(services.intake.get(ALICE, batch.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('checks executor access at validation time', async () => {
    const fixture = await registerRuntime(services, ALICE);
    const privateAgent = await createAgent(
      services,
      ALICE,
      fixture.runtimeId,
      'Private',
    );
    const { drafts } = await services.intake.create(BOB, {
      source: 'paste',
      rawContent: '- A',
    });
    const replaced = await services.intake.putDrafts(BOB, drafts[0]!.batchId, [
      {
        position: 1,
        parentPosition: null,
        fields: { title: 'A', executor: { type: 'agent', id: privateAgent } },
      },
    ]);
    expect(replaced[0]?.validation.errors).toEqual([
      'you do not have access to the executor agent',
    ]);
  });

  it('confirms parents first, marks the origin and enqueues agent executors behind earlier stages', async () => {
    const fixture = await registerRuntime(services, ALICE);
    const agentId = await createAgent(
      services,
      ALICE,
      fixture.runtimeId,
      'Dev',
    );
    await services.agents.update(ALICE, agentId, { access: 'everyone' });
    const project = await services.projects.create(ALICE, { name: 'Web' });
    const { batch } = await services.intake.create(BOB, {
      source: 'paste',
      projectId: project.id,
      rawContent:
        '# Epic #web\n- Step one @stage1\n- Step two @stage2\n- Unassigned',
    });
    const drafts = (await services.intake.get(BOB, batch.id)).drafts;
    await services.intake.putDrafts(
      BOB,
      batch.id,
      drafts.map((draft) =>
        draft.position === 4
          ? {
              ...draft,
              fields: { ...draft.fields, executor: { type: 'none' } },
            }
          : draft,
      ),
    );
    const { issues } = await services.intake.confirm(BOB, batch.id, {
      defaultExecutor: { type: 'agent', id: agentId },
    });
    expect(issues.map((issue) => issue.title)).toEqual([
      'Epic',
      'Step one',
      'Step two',
      'Unassigned',
    ]);
    const created = await rows(db!, 'issues', 'origin_id = ? ORDER BY number', [
      batch.id,
    ]);
    expect(
      created.map((row) => [
        row.origin_type,
        row.created_by_id,
        row.project_id,
      ]),
    ).toEqual(Array(4).fill(['intake', BOB.id, project.id]));
    const [epic, one, two, none] = created;
    expect([
      one?.parent_issue_id,
      two?.parent_issue_id,
      none?.parent_issue_id,
    ]).toEqual([epic?.id, epic?.id, epic?.id]);
    expect([one?.stage, two?.stage]).toEqual([1, 2]);
    expect(none?.executor_type).toBe('none');
    const runs = await runRows(db!);
    expect(runs.map((run) => run.subject_id).sort()).toEqual(
      [epic?.id, one?.id].sort(),
    );
    const deferred = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'run_deferred_blocked'",
      [two?.id],
    );
    expect(deferred).toHaveLength(1);
    const createdActivity = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'issue_created'",
      [epic?.id],
    );
    expect(JSON.parse(createdActivity[0]?.details as string)).toMatchObject({
      intakeBatchId: batch.id,
    });
    expect((await services.intake.get(BOB, batch.id)).batch.status).toBe(
      'confirmed',
    );
    await expect(
      services.intake.confirm(BOB, batch.id, {}),
    ).rejects.toMatchObject({ code: 'INTAKE_STATE_CONFLICT' });
  });

  it('reverts issues without runs and keeps the ones that ran', async () => {
    const fixture = await registerRuntime(services, BOB);
    const agentId = await createAgent(services, BOB, fixture.runtimeId, 'Dev');
    const { batch } = await services.intake.create(BOB, {
      source: 'paste',
      rawContent: '- Ran\n- Idle',
    });
    const drafts = (await services.intake.get(BOB, batch.id)).drafts;
    await services.intake.putDrafts(BOB, batch.id, [
      {
        ...drafts[0]!,
        fields: {
          ...drafts[0]!.fields,
          executor: { type: 'agent', id: agentId },
        },
      },
      drafts[1]!,
    ]);
    const { issues } = await services.intake.confirm(BOB, batch.id, {});
    const result = await services.intake.revert(BOB, batch.id);
    expect(result).toEqual({
      reverted: [issues[1]!.id],
      kept: [issues[0]!.id],
    });
    await expect(
      services.issueQueries.detail(BOB, issues[1]!.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await services.issueQueries.list(BOB, {})).map((item) => item.id),
    ).toEqual([issues[0]!.id]);
    expect((await services.intake.get(BOB, batch.id)).batch.status).toBe(
      'reverted',
    );
    const cancelled = await services.intake.create(BOB, {
      source: 'paste',
      rawContent: '- X',
    });
    expect((await services.intake.cancel(BOB, cancelled.batch.id)).status).toBe(
      'cancelled',
    );
    expect(
      (await services.intake.list(BOB, true)).map((item) => item.status),
    ).toEqual(['cancelled', 'reverted']);
  });

  it('splits an issue description into its sub-tasks', async () => {
    const parent = await services.issues.create(ALICE, {
      title: 'Parent',
      description: '# Frontend\n- Page\n- Stage two (stage 2)',
    });
    const { batch, drafts } = await services.intake.create(ALICE, {
      source: 'issue',
      issueId: parent.identifier,
    });
    expect(batch).toMatchObject({ source: 'issue', sourceIssueId: parent.id });
    expect(drafts.map((draft) => draft.parentPosition)).toEqual([
      null,
      null,
      null,
    ]);
    expect(drafts[2]?.fields.stage).toBe(2);
    await services.intake.confirm(ALICE, batch.id, {});
    const detail = await services.issueQueries.detail(ALICE, parent.id);
    expect(detail.subtasks.map((item) => item.title)).toEqual([
      'Frontend',
      'Page',
      'Stage two',
    ]);
    expect(
      detail.activities.some((item) => item.action === 'intake_confirmed'),
    ).toBe(true);
  });
});

describe.skipIf(!db)(
  'AI intake parser with a fake agent factory (PostgreSQL)',
  () => {
    const answer: IntakeAiResponse = {
      drafts: [
        { position: 1, parentPosition: null, title: 'Epic', priority: 'high' },
        { position: 2, parentPosition: 1, title: 'Child', stage: 1 },
      ],
    };

    it('uses the AI parser when an LLM is configured and settings allow it', async () => {
      const factory = fakeFactory(async () => ({ structuredResponse: answer }));
      await setup({
        aiIntake: createAiIntakeParser(factory),
        aiConfigured: () => true,
      });
      const result = await services.intake.create(BOB, {
        source: 'paste',
        rawContent: 'free text',
      });
      expect(result.parser).toBe('ai');
      expect(result.batch).toMatchObject({
        parser: 'ai',
        aiSessionId: 'session-1',
        parseError: null,
      });
      expect(result.drafts.map((draft) => draft.fields.title)).toEqual([
        'Epic',
        'Child',
      ]);
      expect(factory.createSession).toHaveBeenCalledWith(
        BOB.id,
        expect.any(String),
      );
      const options = vi.mocked(factory.createAgent).mock.calls[0]?.[0];
      expect(options?.systemPrompt).toContain('parentPosition');
    });

    it('falls back to the heuristic on failure, on timeout and on an empty answer', async () => {
      const failing = fakeFactory(async () => {
        throw new Error('provider down');
      });
      await setup({
        aiIntake: createAiIntakeParser(failing),
        aiConfigured: () => true,
      });
      const failed = await services.intake.create(BOB, {
        source: 'paste',
        rawContent: '- A\n- B',
      });
      expect(failed.parser).toBe('heuristic');
      expect(failed.batch.parseError).toBe('provider down');
      expect(failed.drafts).toHaveLength(2);

      const hanging = fakeFactory(() => new Promise(() => undefined));
      await setup({
        aiIntake: createAiIntakeParser(hanging, 50),
        aiConfigured: () => true,
      });
      const timedOut = await services.intake.create(BOB, {
        source: 'paste',
        rawContent: '- A',
      });
      expect(timedOut.parser).toBe('heuristic');
      expect(timedOut.batch.parseError).toMatch(/timed out/u);

      const empty = fakeFactory(async () => ({
        structuredResponse: { drafts: [] },
      }));
      await setup({
        aiIntake: createAiIntakeParser(empty),
        aiConfigured: () => true,
      });
      const none = await services.intake.create(BOB, {
        source: 'paste',
        rawContent: '- A',
      });
      expect(none).toMatchObject({
        parser: 'heuristic',
        batch: { parseError: 'The AI parser returned no drafts.' },
      });
    });

    it('stays heuristic without an LLM or when the setting says heuristic', async () => {
      const factory = fakeFactory(async () => ({ structuredResponse: answer }));
      await setup({
        aiIntake: createAiIntakeParser(factory),
        aiConfigured: () => false,
      });
      expect(
        (
          await services.intake.create(BOB, {
            source: 'paste',
            rawContent: '- A',
          })
        ).parser,
      ).toBe('heuristic');
      await setup({
        aiIntake: createAiIntakeParser(factory),
        aiConfigured: () => true,
      });
      await services.workspaceSettings.update(ALICE, {
        intakeParser: 'heuristic',
      });
      expect(
        (
          await services.intake.create(BOB, {
            source: 'paste',
            rawContent: '- A',
          })
        ).parser,
      ).toBe('heuristic');
      expect(factory.createSession).not.toHaveBeenCalled();
    });
  },
);
