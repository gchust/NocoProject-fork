/**
 * Test doubles for built-in runtimes (NP-219): an AI plugin catalog and connectivity check the test controls, and
 * helpers that enable a built-in runtime and create built-in agents through the real services.
 */
import type { NpServices } from '../../server/modules/services.ts';
import type {
  BuiltinAi,
  BuiltinAiSource,
  BuiltinCatalog,
  BuiltinCheckResult,
} from '../../server/modules/runtime/builtin-ai.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import type { AgentCapability } from '../../server/modules/shared/protocol.capabilities.ts';

export interface FakeAi {
  /** null: the plugin is not registered. */
  present: boolean;
  catalog: BuiltinCatalog;
  check: BuiltinCheckResult;
  readonly checks: { llmService: string; model: string }[];
  readonly source: BuiltinAiSource;
}

export const DEEPSEEK = {
  llmService: 'deepseek',
  title: 'DeepSeek',
  provider: 'deepseek',
  enabledModels: [
    { label: 'DeepSeek Flash', value: 'deepseek-flash' },
    { label: 'DeepSeek Pro', value: 'deepseek-pro' },
  ],
} as const;

export function fakeAi(): FakeAi {
  const fake: FakeAi = {
    present: true,
    catalog: {
      services: [
        { name: 'deepseek', title: 'DeepSeek', provider: 'deepseek' },
        { name: 'idle', title: 'Idle', provider: 'openai' },
      ],
      enabled: [
        DEEPSEEK,
        {
          llmService: 'idle',
          title: 'Idle',
          provider: 'openai',
          enabledModels: [],
        },
      ],
    },
    check: { ok: true, message: null },
    checks: [],
    source: () => (fake.present ? ai : null),
  };
  const ai: BuiltinAi = {
    catalog: async () => fake.catalog,
    testFlight: async (llmService, model) => {
      fake.checks.push({ llmService, model });
      return fake.check;
    },
  };
  return fake;
}

/** Enables `llmService` as a built-in runtime (the actor must be an owner / admin). */
export async function enableBuiltin(
  services: NpServices,
  admin: Actor,
  llmService = 'deepseek',
): Promise<string> {
  const { runtime } = await services.runtimes.enableBuiltin(admin, {
    llmService,
  });
  return runtime.id;
}

export async function createBuiltinAgent(
  services: NpServices,
  owner: Actor,
  runtimeId: string,
  options: {
    readonly name?: string;
    readonly kind?: 'coder' | 'manager';
    readonly capabilities?: readonly AgentCapability[];
    readonly model?: string | null;
    readonly access?: 'ownerOnly' | 'specificUsers' | 'everyone';
  } = {},
): Promise<string> {
  const agent = await services.agents.create(owner, {
    name: options.name ?? 'Helper',
    instructions: 'Answer questions about the project.',
    runtimeId,
    runtimeType: 'builtin',
    provider: 'nocobase-ai',
    model: options.model ?? null,
    kind: options.kind ?? 'coder',
    access: options.access ?? 'everyone',
    capabilities: options.capabilities ?? ['context.read', 'comment.create'],
  });
  return agent.id;
}
