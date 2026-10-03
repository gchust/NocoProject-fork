/**
 * An agent's runtime type (NP-219, protocol-runtime-types.md §3.1): `computer` or `builtin`, required when the agent
 * is created and never changed (400 `RUNTIME_TYPE_IMMUTABLE`; sending the same value is fine).
 *
 * - The runtime must exist, run the agent's provider and be the caller's own or public (as before), and be of the
 *   agent's type (400 `RUNTIME_TYPE_MISMATCH`, checked before `PROVIDER_MISMATCH`).
 * - A built-in agent needs the AI plugin to be created (400 `BUILTIN_RUNTIME_UNAVAILABLE`); its `model` is one of its
 *   service's enabled models (400 `INVALID_MODEL`) or empty for the service's first one, and it has no reasoning
 *   effort. Existing built-in agents stay editable without the plugin unless the model or runtime changes.
 */
import { forbid } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { str } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type { AgentProvider, RuntimeType } from '../shared/protocol.js';
import { RUNTIME_TYPE_AGENT_NAMES } from '../shared/runtime-type-copy.js';
import {
  usableService,
  type BuiltinAiSource,
  type BuiltinCatalog,
} from '../runtime/builtin-ai.js';
import { loadCatalog } from '../runtime/builtin-runtime.js';
import { runtimeTypeOf } from '../runtime/runtime.records.js';

export interface AgentRuntime {
  readonly id: string;
  readonly runtimeType: RuntimeType;
  readonly llmService: string | null;
}

/** The runtime exists, is of `runtimeType`, runs `provider`, and the caller owns it or it is public. */
export async function requireRuntime(
  conn: Conn,
  userId: string,
  runtimeId: unknown,
  provider: AgentProvider,
  runtimeType: RuntimeType,
): Promise<AgentRuntime> {
  if (typeof runtimeId !== 'string' || runtimeId === '')
    throw invalid('INVALID_RUNTIME', 'runtimeId is required.');
  const runtime = await conn.query
    .selectFrom('runtimes')
    .select([
      'id',
      'provider',
      'ownerUserId',
      'visibility',
      'runtimeType',
      'llmService',
    ])
    .where('id', '=', runtimeId)
    .executeTakeFirst();
  if (!runtime) throw invalid('INVALID_RUNTIME', 'runtimeId does not exist.');
  if (runtime.ownerUserId !== userId && runtime.visibility !== 'public')
    forbid('Agents may only use your own runtimes or public runtimes.');
  const actual = runtimeTypeOf(runtime.runtimeType);
  if (actual !== runtimeType)
    throw invalid(
      'RUNTIME_TYPE_MISMATCH',
      `A ${RUNTIME_TYPE_AGENT_NAMES[runtimeType].toLowerCase()} needs a runtime of the same type.`,
      { runtimeType: actual },
    );
  if (runtime.provider !== provider) {
    throw invalid(
      'PROVIDER_MISMATCH',
      `Runtime ${runtimeId} runs ${String(runtime.provider)}, not ${provider}.`,
    );
  }
  return {
    id: runtimeId,
    runtimeType: actual,
    llmService: str(runtime.llmService),
  };
}

/** 400 `RUNTIME_TYPE_IMMUTABLE` when a PATCH asks for another type. */
export function requireSameRuntimeType(
  current: RuntimeType,
  requested: unknown,
): void {
  if (requested !== undefined && requested !== current)
    throw invalid(
      'RUNTIME_TYPE_IMMUTABLE',
      'An agent’s type cannot change; create a new agent instead.',
    );
}

function unavailable(): never {
  throw invalid(
    'BUILTIN_RUNTIME_UNAVAILABLE',
    'The AI plugin is not enabled, so built-in agents are unavailable.',
  );
}

/**
 * The plugin's catalog for a built-in agent's checks; 400 `BUILTIN_RUNTIME_UNAVAILABLE` without the plugin. Read it
 * before the write transaction: the plugin reads its own tables through the application's connection.
 */
export async function requireBuiltinCatalog(
  ai: BuiltinAiSource,
): Promise<BuiltinCatalog> {
  return (await loadCatalog(ai)) ?? unavailable();
}

/** A built-in agent's `model`: empty, or one of its service's enabled models (a null catalog: plugin missing). */
export function requireBuiltinModel(
  catalog: BuiltinCatalog | null,
  llmService: string | null,
  model: string | null,
): void {
  if (model === null) return;
  if (!catalog) unavailable();
  const service = usableService(catalog, llmService);
  if (!service?.enabledModels.some((item) => item.value === model))
    throw invalid(
      'INVALID_MODEL',
      'model is not one of the LLM service’s enabled models.',
    );
}

/**
 * §3.3: only computer agents execute issues, so neither the executor, an executor suggestion, a delegation target nor
 * a stage action's preset executor may be a built-in agent (400 `EXECUTOR_RUNTIME_TYPE`).
 */
export function executorRuntimeTypeError(agentId: string) {
  return invalid(
    'EXECUTOR_RUNTIME_TYPE',
    `Agent ${agentId} is a ${RUNTIME_TYPE_AGENT_NAMES.builtin.toLowerCase()}; only computer agents execute issues.`,
    { agentId },
  );
}

export async function requireExecutorRuntimeType(
  conn: Conn,
  agentId: string,
): Promise<void> {
  const row = await conn.query
    .selectFrom('agents')
    .select('runtimeType')
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (row?.runtimeType === 'builtin') throw executorRuntimeTypeError(agentId);
}

/** The built-in agents among `agentIds`. */
export async function builtinAgentIds(
  conn: Conn,
  agentIds: readonly string[],
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await conn.query
    .selectFrom('agents')
    .select('id')
    .where('id', 'in', [...agentIds])
    .where('runtimeType', '=', 'builtin')
    .execute();
  return new Set(rows.map((row) => String(row.id)));
}
