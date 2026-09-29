/**
 * The one place that decides whether a daemon may work with this server (NP-150, `protocol.daemon-compat.ts`).
 * Register, heartbeat and claim all go through `evaluateDaemon`; no other service may refuse a daemon for its version
 * (`tests/logic/np-daemon-compat-guard.test.ts` enforces that). An unsupported daemon is answered normally and its
 * runtimes are marked `upgrade_required`, so it keeps heartbeating and the computer shows why it does not work.
 */
import type { Tx } from '../shared/db.js';
import { fromJson, now, str, toJson } from '../shared/db.js';
import {
  cliDownloadPath,
  compareVersions,
  LATEST_CLI_VERSION,
  MIN_CLI_VERSION,
  SUPPORTED_PROTOCOLS,
  type DaemonCompatibility,
  type DaemonCompatibilityInfo,
  type RuntimeDaemonInfo,
} from '../shared/protocol.js';

export interface DaemonIdentity {
  /** A daemon that sends none is a protocol 1 daemon. */
  readonly protocolVersion?: unknown;
  readonly minProtocolVersion?: unknown;
  readonly version?: unknown;
  /** Set when evaluating a claim: what the claim request carried. */
  readonly claim?: { readonly configurationProtocol?: unknown };
}

function protocolOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function versionOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim().slice(0, 64)
    : null;
}

/** Protocol 1 is usable only by a daemon that applies NP-125's agent configuration. */
function legacyConfigured(identity: DaemonIdentity): boolean {
  if (identity.claim) return identity.claim.configurationProtocol === 1;
  const version = versionOf(identity.version);
  return !!version && compareVersions(version, MIN_CLI_VERSION) >= 0;
}

export function evaluateDaemon(identity: DaemonIdentity): DaemonCompatibility {
  const speaks = protocolOf(identity.protocolVersion, 1);
  const lowest = Math.min(
    protocolOf(identity.minProtocolVersion, speaks),
    speaks,
  );
  const daemonVersion = versionOf(identity.version);
  const verdict = (
    status: DaemonCompatibility['status'],
    reason: DaemonCompatibility['reason'],
    negotiatedProtocol: number | null,
  ): DaemonCompatibility => ({
    status,
    reason,
    negotiatedProtocol,
    protocols: { ...SUPPORTED_PROTOCOLS },
    daemonVersion,
    latestVersion: LATEST_CLI_VERSION,
    minVersion: MIN_CLI_VERSION,
    updateAvailable:
      !daemonVersion || compareVersions(daemonVersion, LATEST_CLI_VERSION) < 0,
    downloadPath: cliDownloadPath(LATEST_CLI_VERSION),
  });
  if (lowest > SUPPORTED_PROTOCOLS.current)
    return verdict('unsupported', 'daemonTooNew', null);
  const negotiated = Math.min(speaks, SUPPORTED_PROTOCOLS.current);
  if (negotiated < SUPPORTED_PROTOCOLS.min)
    return verdict('unsupported', 'daemonTooOld', negotiated);
  if (negotiated === 1 && !legacyConfigured(identity))
    return verdict('unsupported', 'daemonTooOld', negotiated);
  if (negotiated < SUPPORTED_PROTOCOLS.current)
    return verdict('deprecated', 'protocolDeprecated', negotiated);
  return verdict('ok', 'current', negotiated);
}

/** The runtime status a daemon's runtimes get while it is alive. */
export function liveStatus(
  compatibility: DaemonCompatibility,
): 'online' | 'upgrade_required' {
  return compatibility.status === 'unsupported' ? 'upgrade_required' : 'online';
}

/** What register stores in `runtimes.deviceInfo` so heartbeat and claim can evaluate the daemon again. */
export function daemonDeviceInfo(
  identity: DaemonIdentity & { readonly deviceName?: unknown },
  compatibility: DaemonCompatibility,
): Record<string, unknown> {
  return {
    deviceName: versionOf(identity.deviceName),
    daemonVersion: versionOf(identity.version),
    protocolVersion: protocolOf(identity.protocolVersion, 1),
    minProtocolVersion: protocolOf(
      identity.minProtocolVersion,
      protocolOf(identity.protocolVersion, 1),
    ),
    compatibility: {
      status: compatibility.status,
      reason: compatibility.reason,
    },
  };
}

/** The identity register stored for a runtime row (rows from before NP-150 carry only `daemonVersion`). */
export function storedIdentity(deviceInfo: unknown): DaemonIdentity {
  const info = fromJson<Record<string, unknown>>(deviceInfo) ?? {};
  return {
    protocolVersion: info.protocolVersion,
    minProtocolVersion: info.minProtocolVersion,
    version: info.daemonVersion,
  };
}

/** The daemon fields of a runtime row, evaluated against this server's rules. */
export function runtimeDaemonInfo(
  deviceInfo: unknown,
): RuntimeDaemonInfo | null {
  const info = fromJson<Record<string, unknown>>(deviceInfo);
  if (!info || (info.daemonVersion == null && info.protocolVersion == null))
    return null;
  const compatibility = evaluateDaemon(storedIdentity(info));
  return {
    version: compatibility.daemonVersion,
    protocolVersion: protocolOf(info.protocolVersion, 1),
    status: compatibility.status,
    reason: compatibility.reason,
    updateAvailable: compatibility.updateAvailable,
    latestVersion: compatibility.latestVersion,
  };
}

export interface DaemonRow {
  readonly id: string;
  readonly status: string | null;
}

/**
 * Records that a daemon was seen: its runtimes become `online` or `upgrade_required` (with `deviceInfo` replaced when
 * given), and a change into or out of `upgrade_required` emits `runtime.compatibilityChanged` for the owner's inbox.
 */
export async function markDaemonSeen(
  tx: Tx,
  daemon: {
    readonly ownerUserId: string;
    readonly daemonId: string;
    readonly deviceName: string | null;
    readonly rows: readonly DaemonRow[];
    readonly compatibility: DaemonCompatibility;
    readonly deviceInfo?: Record<string, unknown>;
  },
): Promise<void> {
  if (daemon.rows.length === 0) return;
  const status = liveStatus(daemon.compatibility);
  const timestamp = now();
  await tx.conn.query
    .updateTable('runtimes')
    .set({
      status,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
      ...(daemon.deviceInfo ? { deviceInfo: toJson(daemon.deviceInfo) } : {}),
    })
    .where(
      'id',
      'in',
      daemon.rows.map((row) => row.id),
    )
    .execute();
  if (daemon.rows.some((row) => row.status !== status))
    tx.emit({ type: 'agents.changed' });
  const wasRequired = daemon.rows.some(
    (row) => row.status === 'upgrade_required',
  );
  const required = status === 'upgrade_required';
  if (wasRequired !== required)
    tx.emit({
      type: 'runtime.compatibilityChanged',
      ownerUserId: daemon.ownerUserId,
      daemonId: daemon.daemonId,
      deviceName: daemon.deviceName,
      upgradeRequired: required,
      daemonVersion: daemon.compatibility.daemonVersion,
      latestVersion: daemon.compatibility.latestVersion,
      reason: daemon.compatibility.reason,
    });
}

/** The device name a runtime row carries (for notices). */
export function deviceNameOf(deviceInfo: unknown): string | null {
  return str(fromJson<Record<string, unknown>>(deviceInfo)?.deviceName) ?? null;
}

/** `GET /np/daemon/compatibility`: what this server accepts and the CLI it serves (`serverUrl` includes the base path). */
export function compatibilityInfo(serverUrl: string): DaemonCompatibilityInfo {
  const downloadPath = cliDownloadPath(LATEST_CLI_VERSION);
  return {
    protocols: { ...SUPPORTED_PROTOCOLS },
    latestVersion: LATEST_CLI_VERSION,
    minVersion: MIN_CLI_VERSION,
    downloadPath,
    downloadUrl: `${serverUrl.replace(/\/+$/u, '')}${downloadPath}`,
  };
}
