/**
 * What NocoProject needs from the NocoBase AI plugin for built-in runtimes (NP-219, protocol-runtime-types.md §11.1):
 * the LLM service catalog and a connectivity check. The provider builds it from the plugin's public `aiManagerToken`
 * (`server/providers/np-builtin-ai.ts`); tests pass a double. `null` from the source means the plugin is not
 * registered, which every caller treats as "built-in runtimes unavailable" (§4.3).
 */
import type { BuiltinModel } from '../shared/protocol.js';

export interface BuiltinLlmService {
  readonly name: string;
  readonly title: string;
  readonly provider: string;
}

export interface BuiltinEnabledService {
  readonly llmService: string;
  readonly title: string;
  readonly provider: string;
  readonly enabledModels: readonly BuiltinModel[];
}

export interface BuiltinCatalog {
  /** Every configured service, enabled or not (`llmServiceManager.listLLMServices()`). */
  readonly services: readonly BuiltinLlmService[];
  /** The enabled services and their enabled models (`llmProviderManager.listAllEnabledModels()`). */
  readonly enabled: readonly BuiltinEnabledService[];
}

export interface BuiltinCheckResult {
  readonly ok: boolean;
  /** Why it failed (at most 500 characters); null on success. */
  readonly message: string | null;
}

export interface BuiltinAi {
  catalog(): Promise<BuiltinCatalog>;
  /** One tiny model call (`provider.testFlight()`), bounded by the implementation's timeout. */
  testFlight(llmService: string, model: string): Promise<BuiltinCheckResult>;
}

/** Resolved at request time: the plugin is registered after the services are built. */
export type BuiltinAiSource = () => BuiltinAi | null;

export const noBuiltinAi: BuiltinAiSource = () => null;

/** The enabled service named `llmService` that has at least one enabled model, or null. */
export function usableService(
  catalog: BuiltinCatalog,
  llmService: string | null,
): BuiltinEnabledService | null {
  const service = catalog.enabled.find(
    (item) => item.llmService === llmService,
  );
  return service && service.enabledModels.length > 0 ? service : null;
}
