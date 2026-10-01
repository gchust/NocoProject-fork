/**
 * NP-219: built-in runtimes on the NocoBase AI plugin's public server API only (protocol-runtime-types.md §11.1,
 * ADR-0010). The catalog comes from `llmServiceManager.listLLMServices()` and `llmProviderManager.listAllEnabledModels()`,
 * the connectivity check from `getLLMService(...).provider.testFlight()`. Nothing here reads or writes the plugin's
 * tables, imports its internals or changes its configuration.
 */
import {
  aiManagerToken,
  type AIApplicationConfig,
} from '@nocobase/app-plugin-ai-employee/server';
import type { Application } from '@nocobase/app-server/application';

import type {
  BuiltinAi,
  BuiltinAiSource,
  BuiltinCheckResult,
} from '../modules/runtime/builtin-ai.js';

/** A check is one tiny model call; a provider that does not answer in time counts as failed. */
const CHECK_TIMEOUT_MS = 20_000;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function testFlight(
  app: Application,
  llmService: string,
  model: string,
): Promise<BuiltinCheckResult> {
  const ai = app.container.resolve(aiManagerToken);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BuiltinCheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, message: 'Connectivity check timed out.' }),
      CHECK_TIMEOUT_MS,
    );
  });
  const check = (async (): Promise<BuiltinCheckResult> => {
    const { provider } = await ai.llmProviderManager.getLLMService({
      llmService,
      model,
    });
    const result = await provider.testFlight();
    return result.status === 'success'
      ? { ok: true, message: null }
      : {
          ok: false,
          message: (result.message ?? `code ${result.code}`).slice(0, 500),
        };
  })().catch((error: unknown) => ({ ok: false, message: message(error) }));
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function builtinAi(app: Application): BuiltinAi {
  return {
    async catalog() {
      const ai = app.container.resolve(aiManagerToken);
      const [services, enabled] = await Promise.all([
        ai.llmServiceManager.listLLMServices(),
        ai.llmProviderManager.listAllEnabledModels(),
      ]);
      return {
        services: services.map((service) => ({
          name: service.name,
          title: service.title || service.name,
          provider: service.provider,
        })),
        enabled: enabled.map((service) => ({
          llmService: service.llmService,
          title: service.llmServiceTitle || service.llmService,
          provider: service.provider,
          enabledModels: service.enabledModels.map((model) => ({
            label: model.label || model.value,
            value: model.value,
          })),
        })),
      };
    },
    testFlight: (llmService, model) => testFlight(app, llmService, model),
  };
}

/** Resolved at request time; null while the AI plugin is not registered. */
export function createBuiltinAiSource(app: Application): BuiltinAiSource {
  return () => (app.container.has(aiManagerToken) ? builtinAi(app) : null);
}

/**
 * Whether the AI draft and process classifier have a model (protocol-runtime-types.md §11.3): an enabled service with
 * an enabled model, the same test as a built-in runtime's. The configuration check comes first, so an application
 * without `ai.llmServices` never asks the plugin.
 */
export async function aiModelsConfigured(app: Application): Promise<boolean> {
  if (!app.container.has(aiManagerToken)) return false;
  if (
    (app.config.get<AIApplicationConfig>('ai')?.llmServices?.length ?? 0) === 0
  )
    return false;
  try {
    const enabled = await app.container
      .resolve(aiManagerToken)
      .llmProviderManager.listAllEnabledModels();
    return enabled.some((service) => service.enabledModels.length > 0);
  } catch {
    return false;
  }
}
