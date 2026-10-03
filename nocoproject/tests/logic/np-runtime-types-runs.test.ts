// @vitest-environment node
/**
 * NP-219 runtime types (protocol-runtime-types.md §3.3, §8), on PostgreSQL with a double of the AI plugin: the
 * executor rule (executor, suggestion, delegation, stage preset), personal project managers on built-in runtimes, the
 * runs' type snapshot and the usage / cost split by type. Runtimes and agent rules: `np-runtime-types.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  claimOne,
  createAgent,
  mention,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  runRows,
  setRole,
} from './np-harness.ts';
import {
  createBuiltinAgent,
  enableBuiltin,
  fakeAi,
  type FakeAi,
} from './np-builtin-harness.ts';
import { BUILTIN_PM_CAPABILITIES } from '../../server/modules/agent/capabilities.ts';
import type { NpServices } from '../../server/modules/services.ts';
import { BUILTIN_DEFINITION } from '../../server/modules/issue/status.ts';

const opened = await openNpTestDatabase('np_t_runtime_types_runs');
const skipped = 'skip' in opened;
if (skipped) console.warn(opened.skip);
const db = opened as Exclude<typeof opened, { skip: string }>;
afterAll(() => (skipped ? undefined : db.close()));

let services: NpServices;
let ai: FakeAi;

beforeEach(async () => {
  if (skipped) return;
  await resetData(db);
  ai = fakeAi();
  services = buildServices(db.database, { builtinAi: ai.source }).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'admin');
});

function code(promise: Promise<unknown>) {
  return promise.then(
    () => 'ok',
    (error: { code?: string }) => error.code ?? String(error),
  );
}

describe.skipIf(skipped)('executors', () => {
  it('never makes a built-in agent an executor or a delegation target', async () => {
    const computer = await registerRuntime(services, ALICE);
    const builtin = await enableBuiltin(services, ALICE);
    const helper = await createBuiltinAgent(services, ALICE, builtin);
    const coder = await createAgent(
      services,
      ALICE,
      computer.runtimeId,
      'Coder',
    );
    const issue = await services.issues.create(ALICE, { title: 'Triage' });
    await expect(
      services.issues.patch(ALICE, issue.id, {
        executor: { type: 'agent', id: helper },
        revision: issue.revision,
      }),
    ).rejects.toMatchObject({
      code: 'EXECUTOR_RUNTIME_TYPE',
      details: { agentId: helper },
    });
    expect(
      await code(
        services.issues.create(ALICE, {
          title: 'Direct',
          executor: { type: 'agent', id: helper },
        }),
      ),
    ).toBe('EXECUTOR_RUNTIME_TYPE');
    const current = await services.agents.get(ALICE, coder);
    expect(
      await code(
        services.agents.update(ALICE, coder, {
          delegationTargetIds: [helper],
          configurationRevision: current.configurationRevision,
        }),
      ),
    ).toBe('EXECUTOR_RUNTIME_TYPE');
  });

  it('refuses a built-in agent as an executor suggestion of a sub-issue', async () => {
    const computer = await registerRuntime(services, ALICE);
    const builtin = await enableBuiltin(services, ALICE);
    const helper = await createBuiltinAgent(services, ALICE, builtin);
    const coder = await createAgent(
      services,
      ALICE,
      computer.runtimeId,
      'Coder',
    );
    const issue = await services.issues.create(ALICE, {
      title: 'Parent',
      executor: { type: 'agent', id: coder },
    });
    const run = await claimOne(services, ALICE, computer);
    const auth = await services.runTokens.verify(run!.token);
    expect(
      await code(
        services.agentIssues.create(auth!, {
          title: 'Child',
          parentIssueId: issue.id,
          executor: helper,
        }),
      ),
    ).toBe('EXECUTOR_RUNTIME_TYPE');
  });
});

describe.skipIf(skipped)('runs and usage by type', () => {
  it('snapshots the agent type on its runs, which daemons never claim', async () => {
    const computer = await registerRuntime(services, ALICE);
    const builtin = await enableBuiltin(services, ALICE);
    const helper = await createBuiltinAgent(services, ALICE, builtin);
    const coder = await createAgent(
      services,
      ALICE,
      computer.runtimeId,
      'Coder',
    );
    const issue = await services.issues.create(ALICE, { title: 'Both' });
    await services.comments.create(ALICE, issue.id, {
      content: `${mention(helper, 'Helper')} ${mention(coder, 'Coder')} have a look`,
    });
    const runs = await runRows(db);
    expect(
      runs.map((run) => [run.agent_id, run.runtime_type, run.status]).sort(),
    ).toEqual(
      [
        [coder, 'computer', 'queued'],
        [helper, 'builtin', 'queued'],
      ].sort(),
    );
    // The daemon gets the computer run only, however many slots it offers.
    const claim = await services.claims.claim(
      ALICE.id as string,
      {
        configurationProtocol: 1,
        daemonId: computer.daemonId,
        slots: [{ runtimeId: computer.runtimeId, free: 5 }],
      },
      'http://test',
    );
    expect(claim.runs.map((run) => run.agent.id)).toEqual([coder]);
    expect(await services.claims.claimOne(builtin)).toBeNull();

    const all = await services.issueQueries.runs(ALICE, issue.id);
    expect(
      all.data
        .map((run) => (run as { runtimeType?: string }).runtimeType)
        .sort(),
    ).toEqual(['builtin', 'computer']);
    const only = await services.issueQueries.runs(ALICE, issue.id, 'builtin');
    expect(only.data.map((run) => run.agentId)).toEqual([helper]);
    const helperRun = runs.find((run) => run.agent_id === helper)!;
    expect(
      (await services.runQueries.detail(String(helperRun.id))).runtimeType,
    ).toBe('builtin');
  });

  it('groups usage and splits the cost by type', async () => {
    const computer = await registerRuntime(services, ALICE);
    const builtin = await enableBuiltin(services, ALICE);
    const helper = await createBuiltinAgent(services, ALICE, builtin);
    const coder = await createAgent(
      services,
      ALICE,
      computer.runtimeId,
      'Coder',
    );
    const issue = await services.issues.create(ALICE, { title: 'Spend' });
    await services.comments.create(ALICE, issue.id, {
      content: `${mention(helper, 'Helper')} ${mention(coder, 'Coder')} go`,
    });
    const runs = await runRows(db);
    for (const [index, run] of runs.entries())
      await db.knex.raw(
        `INSERT INTO "${db.schema}".run_usage (id, run_id, provider, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, now())`,
        [
          `u${index}`,
          run.id,
          run.agent_id === helper ? 'deepseek' : 'claude',
          run.agent_id === helper ? 'deepseek-flash' : 'claude-opus',
          run.agent_id === helper ? 1_000_000 : 2_000_000,
          0,
        ],
      );
    const settings = await services.workspaceSettings.view(ALICE);
    await services.workspaceSettings.update(ALICE, {
      modelPrices: [
        {
          provider: 'deepseek',
          model: 'deepseek-*',
          inputPerM: 1,
          outputPerM: 0,
          cacheReadPerM: 0,
          cacheWritePerM: 0,
        },
        {
          provider: 'claude',
          model: '*',
          inputPerM: 3,
          outputPerM: 0,
          cacheReadPerM: 0,
          cacheWritePerM: 0,
        },
      ],
      revision: (settings as { revision?: number }).revision,
    } as never);
    const byType = await services.usage.query(ALICE, {
      groupBy: 'runtimeType',
    });
    expect(
      byType.rows.map((row) => [row.key, row.inputTokens, row.estimatedCost]),
    ).toEqual([
      ['computer', 2_000_000, 6],
      ['builtin', 1_000_000, 1],
    ]);
    const builtinOnly = await services.usage.query(ALICE, {
      groupBy: 'agent',
      runtimeType: 'builtin',
    });
    expect(builtinOnly.rows.map((row) => row.key)).toEqual([helper]);
    expect(
      await code(services.usage.query(ALICE, { runtimeType: 'cloud' })),
    ).toBe('INVALID_RUNTIME_TYPE');
    const metrics = await services.metrics.report(ALICE, {});
    expect(
      (metrics.cost as unknown as { byRuntimeType: unknown }).byRuntimeType,
    ).toEqual({
      computer: { estimatedCost: 6, pricedRuns: 1 },
      builtin: { estimatedCost: 1, pricedRuns: 1 },
    });
  });
});

describe.skipIf(skipped)('personal project managers', () => {
  it('lets a member pick a built-in project manager only on a runtime allowed for project managers', async () => {
    const view = await services.workspaceSettings.view(CAROL);
    const entries = view.agentEntries!;
    await services.workspaceSettings.update(CAROL, {
      agentEntries: {
        ...entries,
        conversation: { ...entries.conversation, allowPersonal: true },
        completion: { ...entries.completion, agentId: null, enabled: false },
      },
    });
    const builtin = await enableBuiltin(services, ALICE);
    const mine = await createBuiltinAgent(services, BOB, builtin, {
      name: 'My PM',
      kind: 'manager',
      access: 'ownerOnly',
      capabilities: [...BUILTIN_PM_CAPABILITIES],
    });
    const choose = () =>
      services.pmAgents.choose(BOB, {
        revision: 1,
        mode: 'personal',
        agentId: mine,
      });
    await expect(choose()).rejects.toMatchObject({
      code: 'PM_AGENT_NOT_ELIGIBLE',
      details: { reason: 'foreignRuntime' },
    });
    await services.runtimes.setPmAllowed(ALICE, builtin, true);
    expect(await choose()).toMatchObject({ mode: 'personal', agentId: mine });
    // Saving a chosen personal project manager re-checks its runtime.
    await services.runtimes.setPmAllowed(ALICE, builtin, false);
    const agent = await services.agents.get(BOB, mine);
    expect(
      await code(
        services.agents.update(BOB, mine, {
          runtimeId: builtin,
          name: 'Still mine',
          configurationRevision: agent.configurationRevision,
        }),
      ),
    ).toBe('PM_AGENT_NOT_ELIGIBLE');
  });
});

describe.skipIf(skipped)('stage action presets', () => {
  it('refuses a built-in agent as a stage action’s preset executor', async () => {
    const computer = await registerRuntime(services, ALICE);
    const builtin = await enableBuiltin(services, ALICE);
    const helper = await createBuiltinAgent(services, ALICE, builtin);
    const coder = await createAgent(
      services,
      ALICE,
      computer.runtimeId,
      'Coder',
    );
    await db.knex.raw(
      `DELETE FROM "${db.schema}".workflow_templates WHERE id = 'wf-types'`,
    );
    await db.knex.raw(
      `INSERT INTO "${db.schema}".workflow_templates (id, name, is_default, definition, created_at, updated_at)
       VALUES ('wf-types', 'Types', false, ?, now(), now())`,
      [JSON.stringify(BUILTIN_DEFINITION)],
    );
    const withPreset = (agentId: string) => ({
      ...BUILTIN_DEFINITION,
      statuses: BUILTIN_DEFINITION.statuses.map((status) =>
        status.key === 'in_review'
          ? { ...status, onEnter: [{ type: 'runExecutor' as const, agentId }] }
          : status,
      ),
    });
    await expect(
      services.workflowProposals.update(ALICE, 'wf-types', {
        definition: withPreset(helper),
        revision: 1,
      }),
    ).rejects.toMatchObject({
      code: 'EXECUTOR_RUNTIME_TYPE',
      details: { agentId: helper },
    });
    expect(
      await code(
        services.workflowProposals.update(ALICE, 'wf-types', {
          definition: withPreset(coder),
          revision: 1,
        }),
      ),
    ).toBe('ok');
  });
});
