/**
 * Runtime types: computer agents and built-in agents (NP-219; docs/phase2/protocol-runtime-types.md).
 *
 * A computer runtime is a daemon's coding tool on a member's computer; a built-in runtime is one LLM service of the
 * NocoBase AI plugin, run by the server itself. An agent's `runtimeType` is set when it is created and never changes.
 * Every shape here extends an existing one (`& RuntimeTypeFields`) instead of changing it, so the CLI's copies of the
 * older types stay intact; the daemon-facing types (`Daemon*`, `ClaimedRun*`) are untouched.
 */
import type { AgentCapability } from './protocol.capabilities.js';
import type { RuntimeVisibility } from './protocol.js';
import type { UsageGroupByV5 } from './protocol.phase2-pm-assistant.js';

export type RuntimeType = 'computer' | 'builtin';
export const RUNTIME_TYPES: readonly RuntimeType[] = ['computer', 'builtin'];

/** The `provider` of every built-in runtime and built-in agent. */
export const BUILTIN_PROVIDER = 'nocobase-ai';

/** Why a built-in runtime is offline (§4.2). */
export type BuiltinStatusReason =
  'plugin_missing' | 'service_removed' | 'no_enabled_model' | 'check_failed';

export interface RuntimeTypeFields {
  readonly runtimeType: RuntimeType;
}

export interface BuiltinModel {
  readonly label: string;
  readonly value: string;
}

/** On every `Runtime` row; only built-in rows fill them (computer rows: null and []). */
export interface RuntimeBuiltinFields {
  readonly llmService: string | null;
  readonly llmServiceTitle: string | null;
  readonly statusReason: BuiltinStatusReason | null;
  readonly lastCheckedAt: string | null;
  readonly enabledModels: readonly BuiltinModel[];
}

/** `GET /np/runtimes/builtin/candidates` */
export interface BuiltinCandidates {
  readonly plugin: 'ready' | 'missing';
  readonly services: readonly {
    readonly llmService: string;
    readonly title: string;
    readonly provider: string;
    readonly enabledModels: readonly BuiltinModel[];
    /** id of the built-in runtime already enabled for it */
    readonly runtimeId: string | null;
  }[];
}

/** `POST /np/runtimes/builtin` */
export interface EnableBuiltinRuntimeRequest {
  readonly llmService: string;
}

/** `PATCH /np/runtimes/:id` */
export interface UpdateRuntimeRequestV2 {
  readonly visibility?: RuntimeVisibility;
  readonly pmAllowed?: boolean;
  /** built-in only */
  readonly name?: string;
}

/** Capabilities a built-in agent may not hold: they need a repository, a terminal or local files (§3.2). */
export const BUILTIN_UNSUPPORTED_CAPABILITIES = [
  'issue.execute',
  'pullRequest.link',
  'repo.read',
  'attachment.upload',
] as const satisfies readonly AgentCapability[];

/** New failure reasons (§6.7). */
export type RuntimeTypeFailureReason =
  'builtinUnavailable' | 'agentError.stepLimit';
export const BUILTIN_RETRYABLE_FAILURE_REASONS: readonly string[] = [
  'agentError.emptyOutput',
  'agentError.stepLimit',
  'agentError.providerNetwork',
];

/** `GET /np/usage?groupBy=runtimeType`: one row per type, keyed `computer` / `builtin` (§8). */
export type UsageGroupByV6 = UsageGroupByV5 | 'runtimeType';

/** `GET /np/metrics`: `cost.byRuntimeType` (§8). */
export interface MetricsCostByRuntimeType {
  readonly estimatedCost: number | null;
  readonly pricedRuns: number;
}
export interface MetricsCostRuntimeTypeFields {
  readonly byRuntimeType: Readonly<
    Record<RuntimeType, MetricsCostByRuntimeType>
  >;
}

/** The project manager drawer's agent view: the type, and why a built-in runtime is unavailable (§9.2). */
export interface PmConversationAgentRuntimeFields extends RuntimeTypeFields {
  readonly statusReason: BuiltinStatusReason | null;
}
