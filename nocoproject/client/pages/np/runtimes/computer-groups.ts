import type { NpComputer } from '../types-computers.js';
import type { Runtime } from '../types.js';

/** NP-188: one computer (daemon) and the runtimes it registered. */
export interface ComputerGroup {
  /** The daemon id, or `runtime:<id>` for a runtime without one. */
  readonly id: string;
  /** The credential's name when the viewer can see it, else the device name. */
  readonly name: string;
  readonly deviceName: string | null;
  readonly ownerName: string | null;
  /** Every credential bound to this daemon is revoked. */
  readonly revoked: boolean;
  readonly runtimes: readonly Runtime[];
  readonly onlineCount: number;
}

/** The group id of agents whose runtime is unset or not visible. */
export const NO_COMPUTER = 'none';

function deviceText(runtime: Runtime, key: string): string | null {
  const value = runtime.deviceInfo?.[key];
  return typeof value === 'string' && value ? value : null;
}

export function runtimeDeviceName(runtime: Runtime): string | null {
  return deviceText(runtime, 'deviceName') ?? deviceText(runtime, 'hostname');
}

export function computerKeyOf(runtime: Runtime): string {
  return runtime.daemonId ? runtime.daemonId : `runtime:${runtime.id}`;
}

/**
 * Groups runtimes by the computer that registered them. Computers with a runtime online come first, then by name.
 * Credentials are optional: a member sees only their own, so others' computers are named after their device.
 */
export function groupRuntimesByComputer(
  runtimes: readonly Runtime[],
  computers: readonly NpComputer[] = [],
): ComputerGroup[] {
  const byKey = new Map<string, Runtime[]>();
  for (const runtime of runtimes) {
    const key = computerKeyOf(runtime);
    const list = byKey.get(key);
    if (list) list.push(runtime);
    else byKey.set(key, [runtime]);
  }
  const groups = [...byKey].map(([id, members]): ComputerGroup => {
    const credentials = computers.filter(
      (computer) => computer.daemonId !== null && computer.daemonId === id,
    );
    const credential =
      credentials.find((computer) => !computer.revokedAt) ?? credentials[0];
    const first = members[0];
    const deviceName = members.map(runtimeDeviceName).find(Boolean) ?? null;
    return {
      id,
      name: credential?.name ?? deviceName ?? first.name,
      deviceName,
      ownerName: first.ownerName ?? credential?.ownerName ?? null,
      revoked:
        credentials.length > 0 &&
        credentials.every((computer) => computer.revokedAt),
      runtimes: members,
      onlineCount: members.filter((runtime) => runtime.status === 'online')
        .length,
    };
  });
  return groups.sort(
    (a, b) =>
      Number(b.onlineCount > 0) - Number(a.onlineCount > 0) ||
      a.name.localeCompare(b.name),
  );
}

/** Runtime id → its computer group id, for grouping agents. */
export function computerKeyByRuntime(
  runtimes: readonly Runtime[],
): Map<string, string> {
  return new Map(
    runtimes.map((runtime) => [runtime.id, computerKeyOf(runtime)]),
  );
}
