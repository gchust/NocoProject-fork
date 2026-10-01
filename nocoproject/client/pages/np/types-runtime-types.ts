import type { AgentCapability } from './agent-capabilities.js';

/**
 * Browser-side types for computer and built-in agents (NP-219, `protocol-runtime-types.md` §5). Copied from the
 * contract rather than imported from `server/modules/shared/protocol.runtime-types.ts` (see `types.ts`); the fields
 * they add to existing shapes are declared, optional, on `Runtime`, `AgentListItem` and `CreateAgentInput` in
 * `types.ts`, so a server that does not send them yet reads as computer.
 */

/** Where an agent works: on a member's computer (daemon + coding tool) or in the system (the AI plugin's models). */
export type RuntimeType = 'computer' | 'builtin';
export const RUNTIME_TYPES: readonly RuntimeType[] = ['computer', 'builtin'];

/** The provider of every built-in runtime and agent (§2, §3.1). */
export const BUILTIN_PROVIDER = 'nocobase-ai';

/** Why a built-in runtime is offline (§4.2); null while it is online. */
export type BuiltinStatusReason =
  'plugin_missing' | 'service_removed' | 'no_enabled_model' | 'check_failed';
export const BUILTIN_STATUS_REASONS: readonly BuiltinStatusReason[] = [
  'plugin_missing',
  'service_removed',
  'no_enabled_model',
  'check_failed',
];

export interface BuiltinModel {
  readonly label: string;
  readonly value: string;
}

/** `GET /np/runtimes/builtin/candidates` (§4.3, §5): the AI plugin's enabled model services. */
export interface BuiltinCandidates {
  readonly plugin: 'ready' | 'missing';
  readonly services: readonly BuiltinCandidate[];
}

export interface BuiltinCandidate {
  readonly llmService: string;
  readonly title: string;
  readonly provider: string;
  readonly enabledModels: readonly BuiltinModel[];
  /** Id of the built-in runtime already enabled for it. */
  readonly runtimeId: string | null;
}

/** `PATCH /np/runtimes/:id` (§5); `name` only for built-in runtimes. */
export interface UpdateRuntimeInput {
  readonly visibility?: 'private' | 'public';
  readonly pmAllowed?: boolean;
  readonly name?: string;
}

/** Capabilities a built-in agent cannot hold (§3.2). */
export const BUILTIN_UNSUPPORTED_CAPABILITIES: readonly AgentCapability[] = [
  'issue.execute',
  'pullRequest.link',
  'repo.read',
  'attachment.upload',
];

/** Error codes of the contract the pages translate (§5). */
export const RUNTIME_TYPE_ERRORS = [
  'INVALID_RUNTIME_TYPE',
  'RUNTIME_TYPE_IMMUTABLE',
  'RUNTIME_TYPE_MISMATCH',
  'CAPABILITY_NOT_FOR_RUNTIME_TYPE',
  'INVALID_MODEL',
  'BUILTIN_RUNTIME_UNAVAILABLE',
  'INVALID_LLM_SERVICE',
  'RUNTIME_EXISTS',
  'RUNTIME_IN_USE',
] as const;
export type RuntimeTypeError = (typeof RUNTIME_TYPE_ERRORS)[number];

/** A record's type; rows from a server without the field are computer (§2: every existing row defaults to it). */
export function runtimeTypeOf(record: {
  readonly runtimeType?: string | null;
}): RuntimeType {
  return record.runtimeType === 'builtin' ? 'builtin' : 'computer';
}

export function readRuntimeType(value: string | null): RuntimeType | null {
  return value === 'computer' || value === 'builtin' ? value : null;
}

export function isBuiltinStatusReason(
  value: unknown,
): value is BuiltinStatusReason {
  return BUILTIN_STATUS_REASONS.includes(value as BuiltinStatusReason);
}

/** The capabilities an agent of this type may hold (NP-219 §3.2); the rest are dropped when the type changes. */
export function capabilitiesForType(
  capabilities: readonly AgentCapability[],
  runtimeType: RuntimeType,
): AgentCapability[] {
  return runtimeType === 'builtin'
    ? capabilities.filter(
        (key) => !BUILTIN_UNSUPPORTED_CAPABILITIES.includes(key),
      )
    : [...capabilities];
}
