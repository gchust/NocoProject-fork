// @vitest-environment node
/**
 * Usage and workspace settings (iteration-2 contract §I): pricing and grouping (pure), the usage query on a real
 * PostgreSQL (grouping, date range, visibility, totals with `pricedRuns`), the issue detail's usage, and
 * `GET/PATCH /np/settings` validation and permissions.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import {
  DEFAULT_METRIC_THRESHOLDS,
  type ModelPrice,
} from '../../server/modules/shared/protocol.ts';
import {
  aggregateUsage,
  priceFor,
  type UsageRecord,
} from '../../server/modules/usage/usage.service.ts';
import {
  ALICE,
  BOB,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const PRICES: ModelPrice[] = [
  {
    provider: 'claude',
    model: 'claude-*',
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheWritePerM: 3.75,
  },
  {
    provider: '*',
    model: 'gpt-5',
    inputPerM: 1,
    outputPerM: 2,
    cacheReadPerM: 0,
    cacheWritePerM: 0,
  },
];

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    runId: 'r1',
    agentId: 'a1',
    issueId: 'i1',
    projectId: null,
    provider: 'claude',
    model: 'claude-sonnet',
    day: '2026-09-01',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

describe('pricing and grouping (pure)', () => {
  it('matches the provider and the model glob', () => {
    expect(priceFor(PRICES, 'claude', 'claude-opus')?.inputPerM).toBe(3);
    expect(priceFor(PRICES, 'CLAUDE', 'Claude-Haiku')?.inputPerM).toBe(3);
    expect(priceFor(PRICES, 'codex', 'gpt-5')?.inputPerM).toBe(1);
    expect(priceFor(PRICES, 'codex', 'gpt-5-mini')).toBeNull();
    expect(priceFor(PRICES, 'claude', null)).toBeNull();
  });

  it('groups, costs priced records only and counts priced runs in the totals', () => {
    const result = aggregateUsage(
      [
        record({ runId: 'r1', outputTokens: 1_000_000 }),
        record({
          runId: 'r1',
          model: 'claude-haiku',
          inputTokens: 0,
          cacheReadTokens: 1_000_000,
        }),
        record({
          runId: 'r2',
          agentId: 'a2',
          provider: 'opencode',
          model: 'deepseek',
          inputTokens: 500,
        }),
      ],
      'agent',
      PRICES,
      new Map([['a1', 'Dev']]),
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        key: 'a1',
        name: 'Dev',
        runs: 1,
        inputTokens: 1_000_000,
        estimatedCost: 18.3,
      }),
      expect.objectContaining({
        key: 'a2',
        name: 'a2',
        runs: 1,
        inputTokens: 500,
        estimatedCost: null,
      }),
    ]);
    expect(result.totals).toMatchObject({
      runs: 2,
      pricedRuns: 1,
      estimatedCost: 18.3,
    });
    expect(
      aggregateUsage(
        [record({}), record({ day: '2026-08-31' })],
        'day',
        [],
      ).rows.map((row) => row.key),
    ).toEqual(['2026-08-31', '2026-09-01']);
  });
});

const opened = await openNpTestDatabase('np_t_usage');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-usage] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
});

let sequence = 0;

/** A completed run on the issue with one usage row (written directly: the daemon path is covered elsewhere). */
async function usage(
  issueId: string,
  agentId: string,
  model: string,
  input: number,
  at = new Date(),
): Promise<void> {
  sequence += 1;
  const runId = `run-${sequence}`;
  await db!.knex.raw(
    `INSERT INTO "${db!.schema}".runs (id, agent_id, status, subject_type, subject_id, created_at, updated_at)
     VALUES (?, ?, 'completed', 'issue', ?, ?, ?)`,
    [runId, agentId, issueId, at, at],
  );
  await db!.knex.raw(
    `INSERT INTO "${db!.schema}".run_usage (id, run_id, provider, model, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, created_at) VALUES (?, ?, 'claude', ?, ?, 100, 10, 1, ?)`,
    [`u-${sequence}`, runId, model, input, at],
  );
}

describe.skipIf(!db)('usage query and settings (PostgreSQL)', () => {
  it('groups by agent, issue, project, day and model within the range, and totals priced runs', async () => {
    const fixture = await registerRuntime(services, ALICE);
    const dev = await createAgent(services, ALICE, fixture.runtimeId, 'Dev');
    const qa = await createAgent(services, ALICE, fixture.runtimeId, 'QA');
    const project = await services.projects.create(ALICE, { name: 'Web' });
    const one = await services.issues.create(ALICE, {
      title: 'One',
      projectId: project.id,
    });
    const two = await services.issues.create(ALICE, { title: 'Two' });
    await usage(one.id, dev, 'claude-sonnet', 1000);
    await usage(one.id, qa, 'claude-sonnet', 2000);
    await usage(two.id, dev, 'other-model', 4000);
    await usage(
      two.id,
      dev,
      'claude-sonnet',
      8,
      new Date('2020-01-01T00:00:00Z'),
    );
    await services.workspaceSettings.update(ALICE, { modelPrices: PRICES });
    const byAgent = await services.usage.query(ALICE, { groupBy: 'agent' });
    expect(
      byAgent.rows.map((row) => [row.name, row.runs, row.inputTokens]),
    ).toEqual([
      ['Dev', 2, 5000],
      ['QA', 1, 2000],
    ]);
    expect(byAgent.totals).toMatchObject({
      runs: 3,
      pricedRuns: 2,
      inputTokens: 7000,
      outputTokens: 300,
    });
    expect(
      byAgent.rows.find((row) => row.name === 'Dev')?.estimatedCost,
    ).toBeCloseTo((1000 * 3 + 100 * 15 + 10 * 0.3 + 1 * 3.75) / 1e6);
    const byIssue = await services.usage.query(ALICE, { groupBy: 'issue' });
    expect(byIssue.rows.map((row) => row.name).sort()).toEqual(
      [`${one.identifier} One`, `${two.identifier} Two`].sort(),
    );
    const byProject = await services.usage.query(ALICE, { groupBy: 'project' });
    expect(byProject.rows.map((row) => [row.key, row.name]).sort()).toEqual(
      [
        ['none', 'none'],
        [project.id, 'Web'],
      ].sort(),
    );
    const byModel = await services.usage.query(ALICE, {
      groupBy: 'model',
      agentId: dev,
    });
    expect(
      byModel.rows.map((row) => [row.key, row.estimatedCost === null]),
    ).toEqual([
      ['other-model', true],
      ['claude-sonnet', false],
    ]);
    const old = await services.usage.query(ALICE, {
      groupBy: 'day',
      from: '2019-12-31',
      to: '2020-01-02',
    });
    expect(old.rows.map((row) => [row.key, row.inputTokens])).toEqual([
      ['2020-01-01', 8],
    ]);
    expect(
      (
        await services.usage.query(ALICE, {
          groupBy: 'agent',
          projectId: project.id,
        })
      ).totals.runs,
    ).toBe(2);
    expect(
      (await services.usage.query(ALICE, { groupBy: 'agent', issueId: two.id }))
        .totals.inputTokens,
    ).toBe(4000);
    await expect(
      services.usage.query(ALICE, { groupBy: 'team' }),
    ).rejects.toMatchObject({ code: 'INVALID_GROUP_BY' });
    await expect(
      services.usage.query(ALICE, { from: '2026-02-01', to: '2026-01-01' }),
    ).rejects.toMatchObject({
      code: 'INVALID_RANGE',
    });
    const detail = await services.issueQueries.detail(ALICE, one.id);
    expect(detail.usage).toMatchObject({
      key: one.id,
      name: one.identifier,
      runs: 2,
      inputTokens: 3000,
      pricedRuns: 2,
    });
  });

  it('shows members only the usage of issues they can see', async () => {
    const fixture = await registerRuntime(services, ALICE);
    const dev = await createAgent(services, ALICE, fixture.runtimeId, 'Dev');
    const secret = await services.projects.create(ALICE, {
      name: 'Secret',
      visibility: 'members',
    });
    const hidden = await services.issues.create(ALICE, {
      title: 'Hidden',
      projectId: secret.id,
    });
    const open = await services.issues.create(ALICE, { title: 'Open' });
    await usage(hidden.id, dev, 'claude-sonnet', 100);
    await usage(open.id, dev, 'claude-sonnet', 10);
    expect(
      (await services.usage.query(ALICE, { groupBy: 'issue' })).totals
        .inputTokens,
    ).toBe(110);
    const member = await services.usage.query(BOB, { groupBy: 'issue' });
    expect(member.rows.map((row) => row.key)).toEqual([open.id]);
    expect(member.totals).toMatchObject({
      inputTokens: 10,
      estimatedCost: null,
      pricedRuns: 0,
    });
  });

  it('reads settings for everyone and lets owner/admin change them with validation', async () => {
    expect(await services.workspaceSettings.view(BOB)).toEqual({
      autoExecuteSubtasksDefault: false,
      prMergedStatus: 'done',
      modelPrices: [],
      intakeParser: 'auto',
      // Iteration 3 §C: the defaults until an owner/admin sets them (np-metrics.test.ts covers PATCH).
      metricThresholds: DEFAULT_METRIC_THRESHOLDS,
      // Iteration 4 §A (np-pm.test.ts covers PATCH).
      defaultProcess: 'auto',
      pmAgentId: null,
      retrospectiveOnDone: true,
      // Phase 2 (NP-77): the stage run loop guard.
      stageRunLimit: 3,
      stageRunWindowHours: 24,
      issuePrefix: 'NP',
      canEdit: false,
    });
    await expect(
      services.workspaceSettings.update(ALICE, { stageRunLimit: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
    await expect(
      services.workspaceSettings.update(ALICE, {
        stageRunWindowHours: 1.5,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
    expect(
      await services.workspaceSettings.update(ALICE, {
        stageRunLimit: 5,
        stageRunWindowHours: 12,
      }),
    ).toMatchObject({ stageRunLimit: 5, stageRunWindowHours: 12 });
    await expect(
      services.workspaceSettings.update(BOB, { intakeParser: 'heuristic' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      services.workspaceSettings.update(ALICE, { prMergedStatus: 'shipped' }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    await expect(
      services.workspaceSettings.update(ALICE, {
        modelPrices: [{ provider: 'x', model: 'y', inputPerM: -1 } as never],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_PRICE' });
    const updated = await services.workspaceSettings.update(ALICE, {
      prMergedStatus: 'in_review',
      autoExecuteSubtasksDefault: true,
      intakeParser: 'heuristic',
      modelPrices: [
        {
          provider: 'claude',
          model: 'claude-*',
          inputPerM: 3,
          outputPerM: 15,
        } as ModelPrice,
      ],
    });
    expect(updated).toMatchObject({
      prMergedStatus: 'in_review',
      autoExecuteSubtasksDefault: true,
      intakeParser: 'heuristic',
      modelPrices: [
        {
          provider: 'claude',
          model: 'claude-*',
          inputPerM: 3,
          outputPerM: 15,
          cacheReadPerM: 0,
          cacheWritePerM: 0,
        },
      ],
      canEdit: true,
    });
    expect(
      (
        await services.workspaceSettings.update(ALICE, {
          prMergedStatus: 'none',
        })
      ).prMergedStatus,
    ).toBe('none');
  });
});
