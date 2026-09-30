/**
 * Daemon version compatibility (NP-150). The server decides, at register, heartbeat and claim, whether a daemon may
 * keep working (`ok`), may keep working but should upgrade (`deprecated`), or must upgrade (`unsupported`). An
 * unsupported daemon is never refused outright: it stays registered and heartbeating, its runtimes show
 * `upgrade_required`, and claims return no runs, so the computer never silently turns "offline".
 *
 * Policy: a change an older daemon may safely ignore (an optional field) keeps the protocol version. A change an older
 * daemon would get wrong bumps `PROTOCOL_VERSION`, and the previous version stays at least `deprecated` for one
 * release. Raising `SUPPORTED_PROTOCOLS.min` (or `MIN_CLI_VERSION`) is only allowed when running on is unsafe, and the
 * pull request must say why.
 *
 * Protocol history:
 * - 1: Phase 0 to NP-125. NP-125 made the claim depend on agent configuration (`configurationProtocol: 1`, CLI
 *   0.4.0); a protocol 1 daemon without it would run agents with the wrong authority, so it is unsupported.
 * - 2: NP-150. Same payloads as protocol 1 with `configurationProtocol: 1`; adds negotiation and `compatibility`.
 */

import type { InboxItemTypeV7 } from './protocol.phase2-signals.js';

/** The header that carries a computer credential on `/np/daemon/*` (NP-150; personal keys use `x-api-key`). */
export const COMPUTER_KEY_HEADER = 'x-np-computer-key';

/** How a daemon authenticated: a computer credential, or its owner's personal API key (accepted for older CLIs). */
export type DaemonCredential = 'computer' | 'personalKey';

/** The protocol versions this server accepts. */
export const SUPPORTED_PROTOCOLS = { min: 1, current: 2 } as const;

/** The CLI version this application ships (`/assets/cli/nocoproject-cli-<version>.tgz`). */
export const LATEST_CLI_VERSION = '0.5.3';

/** The oldest CLI that may still claim runs (NP-125's agent configuration). */
export const MIN_CLI_VERSION = '0.4.0';

/**
 * NP-183: the oldest CLI that may claim a project manager conversation run (it knows `member.act`, the page context
 * and unnumbered issues). Older daemons keep claiming every other run; conversation runs wait for an upgrade.
 */
export const PM_ASSISTANT_MIN_CLI = '0.6.0';

/** The first CLI with `nocoproject upgrade` and `nocoproject daemon install`. */
export const UPGRADE_COMMAND_SINCE = '0.5.0';

export type DaemonCompatibilityStatus = 'ok' | 'deprecated' | 'unsupported';

/**
 * `current`: speaks the current protocol; `protocolDeprecated`: speaks an older protocol that still works;
 * `daemonTooOld`: the daemon must be upgraded; `daemonTooNew`: the daemon only speaks protocols newer than this
 * server (upgrade the server, or install the CLI the server ships).
 */
export type DaemonCompatibilityReason =
  'current' | 'protocolDeprecated' | 'daemonTooOld' | 'daemonTooNew';

export interface DaemonCompatibility {
  readonly status: DaemonCompatibilityStatus;
  readonly reason: DaemonCompatibilityReason;
  /** The protocol both sides use; null when there is none. */
  readonly negotiatedProtocol: number | null;
  readonly protocols: { readonly min: number; readonly current: number };
  readonly daemonVersion: string | null;
  readonly latestVersion: string;
  readonly minVersion: string;
  /** The daemon is older than `latestVersion` (also true for `ok`). */
  readonly updateAvailable: boolean;
  /** Relative to the server address: `/assets/cli/nocoproject-cli-<latestVersion>.tgz`. */
  readonly downloadPath: string;
}

/** `GET /np/daemon/compatibility` (daemon API key): what `nocoproject upgrade` installs. */
export interface DaemonCompatibilityInfo {
  readonly protocols: { readonly min: number; readonly current: number };
  readonly latestVersion: string;
  readonly minVersion: string;
  readonly downloadPath: string;
  readonly downloadUrl: string;
}

/** The daemon fields of a runtime in `GET /np/runtimes` (from what its daemon last reported). */
export interface RuntimeDaemonInfo {
  readonly version: string | null;
  readonly protocolVersion: number | null;
  readonly status: DaemonCompatibilityStatus;
  readonly reason: DaemonCompatibilityReason;
  readonly updateAvailable: boolean;
  readonly latestVersion: string;
  /** How the daemon last authenticated; null for rows from before NP-150's credentials. */
  readonly credential: DaemonCredential | null;
}

/** Protocol 2 additions to register (optional: a protocol 1 daemon sends neither). */
export interface DaemonRegisterRequestV2 {
  /** The oldest protocol the daemon can speak; the server picks the highest both support. */
  readonly minProtocolVersion?: number;
}

/** Protocol 2 additions to the register, heartbeat and claim responses. Older daemons ignore them. */
export interface DaemonCompatibilityResponse {
  readonly compatibility?: DaemonCompatibility;
}

/** Protocol 2 additions to heartbeat: lets the server re-evaluate a daemon without a new register. */
export interface DaemonHeartbeatRequestV2 {
  readonly version?: string;
  readonly protocolVersion?: number;
  readonly minProtocolVersion?: number;
}

/**
 * `runtime_upgrade_required`: info to a computer's owner when its daemon must be upgraded (no issue; one card per
 * computer while it stays unsupported, resolved when it registers compatibly again).
 */
export type InboxItemTypeV8 = InboxItemTypeV7 | 'runtime_upgrade_required';

export function cliDownloadPath(version: string): string {
  return `/assets/cli/nocoproject-cli-${version}.tgz`;
}

/** Compares dotted numeric versions (`0.10.0` > `0.9.1`); a pre-release suffix is ignored. -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .replace(/[-+].*$/u, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The command that upgrades a daemon of `daemonVersion` against `serverUrl` (the application address including its
 * base path): `nocoproject upgrade` from `UPGRADE_COMMAND_SINCE` on, otherwise installing the served tarball and
 * the boot service by hand.
 */
export function upgradeCommand(
  serverUrl: string,
  daemonVersion: string | null,
  latestVersion: string = LATEST_CLI_VERSION,
): string {
  if (
    daemonVersion &&
    compareVersions(daemonVersion, UPGRADE_COMMAND_SINCE) >= 0
  )
    return 'nocoproject upgrade';
  const base = serverUrl.replace(/\/+$/u, '');
  return `npm i -g ${base}${cliDownloadPath(latestVersion)} && nocoproject daemon install`;
}
