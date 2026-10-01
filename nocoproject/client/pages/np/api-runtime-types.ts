import { ApiClientError, type ApiClient } from '@nocobase/app-client';

import type { Runtime } from './types.js';
import type {
  BuiltinCandidates,
  RuntimeTypeError,
  UpdateRuntimeInput,
} from './types-runtime-types.js';
import { RUNTIME_TYPE_ERRORS } from './types-runtime-types.js';

/**
 * Built-in runtime endpoints (NP-219, `protocol-runtime-types.md` §5). Paths are under `/api/np`; every response is
 * `{ data }`. Enabling, testing and deleting need the general settings' `update`.
 */

/** Query key of the AI plugin's model services (`GET /np/runtimes/builtin/candidates`). */
export const BUILTIN_CANDIDATES_KEY = ['np', 'runtimes', 'builtin-candidates'];

function id(value: string): string {
  return encodeURIComponent(value);
}

export async function fetchBuiltinCandidates(
  api: ApiClient,
): Promise<BuiltinCandidates> {
  const { data } = await api.request<{ data: BuiltinCandidates }>({
    path: 'np/runtimes/builtin/candidates',
  });
  return data;
}

/** Enables one of the AI plugin's model services as a built-in runtime; the server tests it right away. */
export async function enableBuiltinRuntime(
  api: ApiClient,
  llmService: string,
): Promise<Runtime> {
  const { data } = await api.request<{ data: Runtime }, { llmService: string }>(
    { path: 'np/runtimes/builtin', method: 'POST', json: { llmService } },
  );
  return data;
}

export async function updateRuntime(
  api: ApiClient,
  runtimeId: string,
  changes: UpdateRuntimeInput,
): Promise<Runtime> {
  const { data } = await api.request<{ data: Runtime }, UpdateRuntimeInput>({
    path: `np/runtimes/${id(runtimeId)}`,
    method: 'PATCH',
    json: changes,
  });
  return data;
}

/** Built-in runtimes only; 409 `RUNTIME_IN_USE` while an agent still uses it. */
export async function deleteRuntime(
  api: ApiClient,
  runtimeId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/runtimes/${id(runtimeId)}`,
    method: 'DELETE',
  });
}

/** Connection test of a built-in runtime; a failure comes back as an error whose `details.message` says why. */
export async function checkRuntime(
  api: ApiClient,
  runtimeId: string,
): Promise<Runtime> {
  const { data } = await api.request<{ data: Runtime }>({
    path: `np/runtimes/${id(runtimeId)}/check`,
    method: 'POST',
  });
  return data;
}

/** The contract's error code of a failed request, when it is one the pages translate. */
export function runtimeTypeErrorOf(error: unknown): RuntimeTypeError | null {
  if (!(error instanceof ApiClientError)) return null;
  return RUNTIME_TYPE_ERRORS.find((code) => code === error.code) ?? null;
}

/** A string list from the error body's `details` (`details.agentIds`, `details.capabilities`). */
export function errorDetailList(error: unknown, key: string): string[] {
  if (!(error instanceof ApiClientError)) return [];
  const details = (error.payload as { details?: unknown } | null)?.details;
  if (!details || typeof details !== 'object') return [];
  const value = (details as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** `details.message` of a failed connection test (§4.3), when the server gave one. */
export function errorDetailMessage(error: unknown): string | null {
  if (!(error instanceof ApiClientError)) return null;
  const message = (error.payload as { details?: { message?: unknown } } | null)
    ?.details?.message;
  return typeof message === 'string' && message.trim() ? message : null;
}
