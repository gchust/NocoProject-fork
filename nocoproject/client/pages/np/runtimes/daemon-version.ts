import { CLI_VERSION } from '../constants.js';
import type { Runtime } from '../types.js';

/**
 * Daemon CLI versions in the browser (NP-150), copied from `server/modules/shared/protocol.daemon-compat.ts` (the
 * client does not import server sources; see `types.ts`). `CLI_VERSION` is the version this application serves.
 */

/** The first CLI with `nocoproject upgrade` and `nocoproject daemon install`. */
export const UPGRADE_COMMAND_SINCE = '0.5.0';

/** Compares dotted numeric versions; a pre-release suffix is ignored. -1, 0 or 1. */
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

/** What upgrades a daemon of `daemonVersion`: `nocoproject upgrade`, or the served tarball and the boot service. */
export function upgradeCommand(
  serverUrl: string,
  daemonVersion: string | null,
): string {
  if (
    daemonVersion &&
    compareVersions(daemonVersion, UPGRADE_COMMAND_SINCE) >= 0
  )
    return 'nocoproject upgrade';
  const base = serverUrl.replace(/\/+$/u, '');
  return `npm i -g ${base}/assets/cli/nocoproject-cli-${CLI_VERSION}.tgz && nocoproject daemon install`;
}

/**
 * `required`: the daemon must be upgraded before it runs agents; `behind`: it works but a newer CLI is served;
 * `current`; `unknown`: the daemon never reported its version.
 */
export type RuntimeCliState = 'required' | 'behind' | 'current' | 'unknown';

export function runtimeCliVersion(runtime: Runtime): string | null {
  if (runtime.daemon?.version) return runtime.daemon.version;
  const value = runtime.deviceInfo?.daemonVersion;
  return typeof value === 'string' && value ? value : null;
}

export function runtimeCliState(runtime: Runtime): RuntimeCliState {
  if (
    runtime.status === 'upgrade_required' ||
    runtime.daemon?.status === 'unsupported'
  )
    return 'required';
  const version = runtimeCliVersion(runtime);
  if (!version) return 'unknown';
  return compareVersions(version, CLI_VERSION) < 0 ? 'behind' : 'current';
}
