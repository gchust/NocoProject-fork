// @vitest-environment node
/**
 * NP-219 runtime types (protocol-runtime-types.md §3.1, §3.2, §4), on PostgreSQL with a double of the AI plugin:
 * built-in runtimes (enable, status, check, rename, delete) and the agent type rules. Executors, runs and usage:
 * `np-runtime-types-runs.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

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
} from './np-harness.ts';
import {
  createBuiltinAgent,
  enableBuiltin,
  fakeAi,
  type FakeAi,
} from './np-builtin-harness.ts';
import { BUILTIN_PM_CAPABILITIES } from '../../server/modules/agent/capabilities.ts';
import type { NpServices } from '../../server/modules/services.ts';
import { PM_CAPABILITIES } from '../../server/modules/shared/protocol.ts';

const opened = await openNpTestDatabase('np_t_runtime_types');
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

describe.skipIf(skipped)('built-in runtimes', () => {
  it('lists candidates, enables one service once and checks it', async () => {
    ai.present = false;
    expect(await services.runtimes.builtinCandidates(ALICE)).toEqual({
      plugin: 'missing',
      services: [],
    });
    expect(await code(enableBuiltin(services, ALICE))).toBe(
      'BUILTIN_RUNTIME_UNAVAILABLE',
    );
    ai.present = true;
    const before = await services.runtimes.builtinCandidates(ALICE);
    // The service without an enabled model is no candidate.
    expect(before.services.map((item) => item.llmService)).toEqual([
      'deepseek',
    ]);
    expect(before.services[0]!.runtimeId).toBeNull();
    expect(await code(enableBuiltin(services, BOB))).toBe('FORBIDDEN');
    expect(await code(services.runtimes.builtinCandidates(BOB))).toBe(
      'FORBIDDEN',
    );
    expect(await code(enableBuiltin(services, ALICE, 'idle'))).toBe(
      'INVALID_LLM_SERVICE',
    );

    const id = await enableBuiltin(services, CAROL);
    expect(ai.checks).toEqual([
      { llmService: 'deepseek', model: 'deepseek-flash' },
    ]);
    const [row] = await rows(db, 'runtimes', 'id = ?', [id]);
    expect(row).toMatchObject({
      runtime_type: 'builtin',
      provider: 'nocobase-ai',
      daemon_id: 'builtin:deepseek',
      llm_service: 'deepseek',
      kind: 'server',
      owner_user_id: CAROL.id,
      visibility: 'public',
      pm_allowed: false,
      status: 'online',
      status_reason: null,
    });
    expect(row!.last_checked_at).not.toBeNull();
    expect(await code(enableBuiltin(services, ALICE))).toBe('RUNTIME_EXISTS');
    expect(
      (await services.runtimes.builtinCandidates(ALICE)).services[0]!.runtimeId,
    ).toBe(id);
  });

  it('computes the status from the plugin catalog and keeps a failed check until one passes', async () => {
    const computer = await registerRuntime(services, BOB);
    const id = await enableBuiltin(services, ALICE);
    const view = async () =>
      (await services.runtimes.list('builtin')).find((item) => item.id === id)!;
    expect(await view()).toMatchObject({
      runtimeType: 'builtin',
      status: 'online',
      online: true,
      statusReason: null,
      llmService: 'deepseek',
      llmServiceTitle: 'DeepSeek',
      enabledModels: [
        { label: 'DeepSeek Flash', value: 'deepseek-flash' },
        { label: 'DeepSeek Pro', value: 'deepseek-pro' },
      ],
    });
    expect((await services.runtimes.list('builtin')).map((r) => r.id)).toEqual([
      id,
    ]);
    expect((await services.runtimes.list('computer')).map((r) => r.id)).toEqual(
      [computer.runtimeId],
    );
    const computerView = (await services.runtimes.list()).find(
      (item) => item.id === computer.runtimeId,
    )!;
    expect(computerView).toMatchObject({
      runtimeType: 'computer',
      llmService: null,
      statusReason: null,
      enabledModels: [],
    });

    const full = ai.catalog;
    ai.catalog = {
      ...full,
      enabled: full.enabled.filter((s) => s.llmService !== 'deepseek'),
    };
    expect(await view()).toMatchObject({
      status: 'offline',
      online: false,
      statusReason: 'no_enabled_model',
    });
    ai.catalog = { services: [], enabled: [] };
    expect((await view()).statusReason).toBe('service_removed');
    ai.present = false;
    expect((await view()).statusReason).toBe('plugin_missing');
    ai.present = true;
    ai.catalog = full;
    expect((await view()).status).toBe('online');

    ai.check = { ok: false, message: '401 invalid api key' };
    const failed = await services.runtimes.checkBuiltin(ALICE, id);
    expect(failed.message).toBe('401 invalid api key');
    expect(failed.runtime).toMatchObject({
      status: 'offline',
      statusReason: 'check_failed',
    });
    // Listing never clears a failed check; a passing check does.
    expect((await view()).statusReason).toBe('check_failed');
    ai.check = { ok: true, message: null };
    expect(
      (await services.runtimes.checkBuiltin(ALICE, id)).runtime.status,
    ).toBe('online');
    expect(await code(services.runtimes.checkBuiltin(BOB, id))).toBe(
      'FORBIDDEN',
    );
    expect(
      await code(services.runtimes.checkBuiltin(ALICE, computer.runtimeId)),
    ).toBe('INVALID_RUNTIME');
  });

  it('is never marked offline by the sweeper and has no heartbeat window', async () => {
    const id = await enableBuiltin(services, ALICE);
    await db.knex.raw(
      `UPDATE "${db.schema}".runtimes SET last_seen_at = now() - interval '1 day' WHERE id = ?`,
      [id],
    );
    const result = await services.sweeper.sweep(new Date());
    expect(result.runtimesOffline).toBe(0);
    const [row] = await rows(db, 'runtimes', 'id = ?', [id]);
    expect(row!.status).toBe('online');
    const listed = (await services.runtimes.list()).find(
      (item) => item.id === id,
    );
    expect(listed?.online).toBe(true);
  });

  it('is renamed, shared and deleted by owners / admins, never while an agent uses it', async () => {
    const computer = await registerRuntime(services, BOB);
    const id = await enableBuiltin(services, ALICE);
    expect(
      (await services.runtimes.rename(CAROL, id, ' Ask DeepSeek ')).name,
    ).toBe('Ask DeepSeek');
    expect(await code(services.runtimes.rename(BOB, id, 'x'))).toBe(
      'FORBIDDEN',
    );
    expect(
      await code(services.runtimes.rename(BOB, computer.runtimeId, 'x')),
    ).toBe('INVALID_RUNTIME');
    expect(
      (await services.runtimes.setVisibility(CAROL, id, 'private')).visibility,
    ).toBe('private');
    expect(await code(services.runtimes.setVisibility(BOB, id, 'public'))).toBe(
      'FORBIDDEN',
    );
    await services.runtimes.setVisibility(CAROL, id, 'public');
    expect(
      (await services.runtimes.setPmAllowed(CAROL, id, true)).pmAllowed,
    ).toBe(true);

    const agentId = await createBuiltinAgent(services, BOB, id);
    await expect(services.runtimes.remove(ALICE, id)).rejects.toMatchObject({
      code: 'RUNTIME_IN_USE',
      details: { agentIds: [agentId] },
    });
    expect(
      await code(services.runtimes.remove(ALICE, computer.runtimeId)),
    ).toBe('INVALID_RUNTIME');
    expect(await code(services.runtimes.remove(BOB, id))).toBe('FORBIDDEN');
    await services.agents.remove(BOB, agentId);
    await services.runtimes.remove(ALICE, id);
    expect(await rows(db, 'runtimes', 'id = ?', [id])).toEqual([]);
  });
});

describe.skipIf(skipped)('agent types', () => {
  it('requires a type that matches the runtime, and the plugin for a built-in agent', async () => {
    const computer = await registerRuntime(services, BOB);
    const builtin = await enableBuiltin(services, ALICE);
    const base = {
      name: 'X',
      instructions: '',
      capabilities: ['context.read' as const],
    };
    expect(
      await code(
        services.agents.create(BOB, {
          ...base,
          runtimeId: computer.runtimeId,
          provider: 'echo',
        }),
      ),
    ).toBe('INVALID_RUNTIME_TYPE');
    expect(
      await code(
        services.agents.create(BOB, {
          ...base,
          runtimeType: 'server',
          runtimeId: computer.runtimeId,
          provider: 'echo',
        }),
      ),
    ).toBe('INVALID_RUNTIME_TYPE');
    expect(
      await code(
        services.agents.create(BOB, {
          ...base,
          runtimeType: 'builtin',
          runtimeId: computer.runtimeId,
          provider: 'nocobase-ai',
        }),
      ),
    ).toBe('RUNTIME_TYPE_MISMATCH');
    expect(
      await code(
        services.agents.create(BOB, {
          ...base,
          runtimeType: 'computer',
          runtimeId: builtin,
          provider: 'nocobase-ai',
        }),
      ),
    ).toBe('RUNTIME_TYPE_MISMATCH');
    expect(
      await code(
        services.agents.create(BOB, {
          ...base,
          runtimeType: 'builtin',
          runtimeId: builtin,
          provider: 'claude',
        }),
      ),
    ).toBe('PROVIDER_MISMATCH');
    ai.present = false;
    expect(await code(createBuiltinAgent(services, BOB, builtin))).toBe(
      'BUILTIN_RUNTIME_UNAVAILABLE',
    );
  });

  it('validates a built-in agent’s capabilities, model and reasoning effort', async () => {
    const builtin = await enableBuiltin(services, ALICE);
    await expect(
      createBuiltinAgent(services, BOB, builtin, {
        capabilities: ['context.read', 'issue.execute', 'repo.read'],
      }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_FOR_RUNTIME_TYPE',
      details: { capabilities: ['issue.execute', 'repo.read'] },
    });
    expect(
      await code(
        createBuiltinAgent(services, BOB, builtin, { model: 'gpt-5' }),
      ),
    ).toBe('INVALID_MODEL');
    const agent = await services.agents.create(BOB, {
      name: 'Helper',
      instructions: '',
      runtimeId: builtin,
      runtimeType: 'builtin',
      provider: 'nocobase-ai',
      model: 'deepseek-pro',
      reasoningEffort: 'high',
      capabilities: ['context.read', 'comment.create', 'workspace.read'],
    });
    expect(agent).toMatchObject({
      runtimeType: 'builtin',
      provider: 'nocobase-ai',
      model: 'deepseek-pro',
      reasoningEffort: null,
      runtimeOnline: true,
    });
    const [row] = await rows(db, 'agents', 'id = ?', [agent.id]);
    expect(row).toMatchObject({
      runtime_type: 'builtin',
      reasoning_effort: null,
    });

    const patch = (values: Record<string, unknown>) =>
      services.agents.get(BOB, agent.id).then((current) =>
        services.agents.update(BOB, agent.id, {
          ...values,
          configurationRevision: current.configurationRevision,
        }),
      );
    expect(await code(patch({ runtimeType: 'computer' }))).toBe(
      'RUNTIME_TYPE_IMMUTABLE',
    );
    expect(await code(patch({ runtimeType: 'builtin', name: 'Same' }))).toBe(
      'ok',
    );
    expect(
      await code(
        patch({ capabilities: ['context.read', 'attachment.upload'] }),
      ),
    ).toBe('CAPABILITY_NOT_FOR_RUNTIME_TYPE');
    expect(await code(patch({ model: 'nope' }))).toBe('INVALID_MODEL');
    expect(
      (await patch({ reasoningEffort: 'max' })).reasoningEffort,
    ).toBeNull();
    // Without the plugin a built-in agent stays editable, but its model cannot be checked, so it cannot change.
    ai.present = false;
    expect((await patch({ name: 'Renamed' })).name).toBe('Renamed');
    expect(await code(patch({ model: 'deepseek-flash' }))).toBe(
      'BUILTIN_RUNTIME_UNAVAILABLE',
    );
  });

  it('keeps a computer agent’s type and computer runtimes', async () => {
    const computer = await registerRuntime(services, BOB);
    const builtin = await enableBuiltin(services, ALICE);
    const id = await createAgent(services, BOB, computer.runtimeId, 'Coder');
    const current = await services.agents.get(BOB, id);
    expect(current.runtimeType).toBe('computer');
    expect(
      await code(
        services.agents.update(BOB, id, {
          runtimeType: 'builtin',
          configurationRevision: current.configurationRevision,
        }),
      ),
    ).toBe('RUNTIME_TYPE_IMMUTABLE');
    expect(
      await code(
        services.agents.update(BOB, id, {
          runtimeId: builtin,
          configurationRevision: current.configurationRevision,
        }),
      ),
    ).toBe('RUNTIME_TYPE_MISMATCH');
    // A daemon cannot register the built-in provider.
    expect(
      await code(
        services.runtimes.register(
          BOB.id as string,
          {
            daemonId: 'sneaky',
            runtimes: [{ provider: 'nocobase-ai' as never }],
          } as never,
        ),
      ),
    ).toBe('INVALID_REGISTER');
  });

  it('fixes a built-in project manager’s capabilities without repo.read', async () => {
    const builtin = await enableBuiltin(services, ALICE);
    const id = await createBuiltinAgent(services, ALICE, builtin, {
      kind: 'manager',
      capabilities: [...BUILTIN_PM_CAPABILITIES],
    });
    const agent = await services.agents.get(ALICE, id);
    expect([...agent.capabilities].sort()).toEqual(
      [...BUILTIN_PM_CAPABILITIES].sort(),
    );
    expect(agent.capabilities).not.toContain('repo.read');
    expect(
      await code(
        services.agents.update(ALICE, id, {
          capabilities: [...PM_CAPABILITIES],
          configurationRevision: agent.configurationRevision,
        }),
      ),
    ).toBe('MANAGER_CAPABILITIES_FIXED');
    expect(
      await code(
        services.agents.update(ALICE, id, {
          capabilities: [...BUILTIN_PM_CAPABILITIES],
          configurationRevision: agent.configurationRevision,
        }),
      ),
    ).toBe('ok');
  });
});
