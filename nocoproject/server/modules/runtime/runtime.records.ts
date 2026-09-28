/**
 * Row mapping for the `runtimes` table.
 */
import { fromJson, iso, isoOrNull, str, toDate } from '../shared/db.js';
import {
  RUNTIME_OFFLINE_AFTER_SECONDS,
  type AgentProvider,
  type Runtime,
  type RuntimeCapabilities,
  type RuntimeKind,
  type RuntimeVisibility,
} from '../shared/protocol.js';

export const AGENT_PROVIDERS: readonly AgentProvider[] = [
  'claude',
  'opencode',
  'codex',
  'echo',
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return (
    typeof value === 'string' &&
    (AGENT_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Online = marked online and seen within the offline window. */
export function isOnline(
  status: unknown,
  lastSeenAt: unknown,
  at: Date = new Date(),
): boolean {
  const seen = toDate(lastSeenAt);
  return (
    status === 'online' &&
    !!seen &&
    at.getTime() - seen.getTime() < RUNTIME_OFFLINE_AFTER_SECONDS * 1000
  );
}

export function mapRuntime(row: Record<string, unknown>): Runtime {
  return {
    id: str(row.id) ?? '',
    daemonId: str(row.daemonId) ?? '',
    provider: (str(row.provider) ?? 'echo') as AgentProvider,
    name: str(row.name) ?? '',
    kind: (str(row.kind) ?? 'personal') as RuntimeKind,
    ownerUserId: str(row.ownerUserId) ?? '',
    ownerName: null,
    visibility: (str(row.visibility) ?? 'private') as RuntimeVisibility,
    status: row.status === 'online' ? 'online' : 'offline',
    online: isOnline(row.status, row.lastSeenAt),
    lastSeenAt: isoOrNull(row.lastSeenAt),
    version: str(row.version),
    capabilities: fromJson<RuntimeCapabilities>(row.capabilities),
    deviceInfo: fromJson<Record<string, unknown>>(row.deviceInfo),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
