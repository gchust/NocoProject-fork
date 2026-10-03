/**
 * Row mapping for the `runtimes` table. NP-219: a row is a computer runtime (a daemon's coding tool) or a built-in
 * runtime (an LLM service of the AI plugin, `provider = 'nocobase-ai'`); see `builtin-runtime.ts`.
 */
import { fromJson, iso, isoOrNull, str, toDate } from '../shared/db.js';
import {
  BUILTIN_PROVIDER,
  RUNTIME_OFFLINE_AFTER_SECONDS,
  type AgentProvider,
  type BuiltinStatusReason,
  type RuntimeBuiltinFields,
  type RuntimeType,
  type RuntimeTypeFields,
  type Runtime,
  type RuntimeCapabilities,
  type RuntimeKind,
  type RuntimeVisibility,
} from '../shared/protocol.js';
import type { RuntimePmFields } from '../shared/protocol.js';
import { runtimeDaemonInfo } from './daemon-compat.js';

/** The coding tools a daemon may register (never `nocobase-ai`). */
export const COMPUTER_PROVIDERS: readonly AgentProvider[] = [
  'claude',
  'opencode',
  'codex',
  'echo',
];

export const AGENT_PROVIDERS: readonly AgentProvider[] = [
  ...COMPUTER_PROVIDERS,
  BUILTIN_PROVIDER,
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return (
    typeof value === 'string' &&
    (AGENT_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isComputerProvider(value: unknown): value is AgentProvider {
  return (
    typeof value === 'string' &&
    (COMPUTER_PROVIDERS as readonly string[]).includes(value)
  );
}

/** A stored runtime type (anything unknown reads as `computer`, the type of every row before NP-219). */
export function runtimeTypeOf(value: unknown): RuntimeType {
  return value === 'builtin' ? 'builtin' : 'computer';
}

const STATUS_REASONS: readonly BuiltinStatusReason[] = [
  'plugin_missing',
  'service_removed',
  'no_enabled_model',
  'check_failed',
];

export function statusReasonOf(value: unknown): BuiltinStatusReason | null {
  return (STATUS_REASONS as readonly unknown[]).includes(value)
    ? (value as BuiltinStatusReason)
    : null;
}

/**
 * Online = marked online and seen within the offline window. A built-in runtime has no heartbeat: its status is
 * computed by the server (§4.2), so `online` is all there is to it.
 */
export function isOnline(
  status: unknown,
  lastSeenAt: unknown,
  at: Date = new Date(),
  runtimeType: unknown = 'computer',
): boolean {
  if (runtimeTypeOf(runtimeType) === 'builtin') return status === 'online';
  const seen = toDate(lastSeenAt);
  return (
    status === 'online' &&
    !!seen &&
    at.getTime() - seen.getTime() < RUNTIME_OFFLINE_AFTER_SECONDS * 1000
  );
}

export type RuntimeView = Runtime &
  RuntimePmFields &
  RuntimeTypeFields &
  RuntimeBuiltinFields;

export function mapRuntime(row: Record<string, unknown>): RuntimeView {
  const runtimeType = runtimeTypeOf(row.runtimeType);
  return {
    id: str(row.id) ?? '',
    daemonId: str(row.daemonId) ?? '',
    provider: (str(row.provider) ?? 'echo') as AgentProvider,
    name: str(row.name) ?? '',
    kind: (str(row.kind) ?? 'personal') as RuntimeKind,
    ownerUserId: str(row.ownerUserId) ?? '',
    ownerName: null,
    visibility: (str(row.visibility) ?? 'private') as RuntimeVisibility,
    pmAllowed: row.pmAllowed === true || row.pmAllowed === 1,
    status:
      row.status === 'online' || row.status === 'upgrade_required'
        ? row.status
        : 'offline',
    online: isOnline(row.status, row.lastSeenAt, new Date(), runtimeType),
    lastSeenAt: isoOrNull(row.lastSeenAt),
    version: str(row.version),
    capabilities: fromJson<RuntimeCapabilities>(row.capabilities),
    deviceInfo: fromJson<Record<string, unknown>>(row.deviceInfo),
    daemon: runtimeDaemonInfo(row.deviceInfo),
    runtimeType,
    llmService: str(row.llmService),
    // Filled from the AI plugin's catalog by the runtime service.
    llmServiceTitle: null,
    statusReason:
      runtimeType === 'builtin' ? statusReasonOf(row.statusReason) : null,
    lastCheckedAt: isoOrNull(row.lastCheckedAt),
    enabledModels: [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
