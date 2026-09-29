// @vitest-environment node
/**
 * Guards against the NP-125 incident (NP-150): a service that refuses a daemon on its own (a new required field
 * answered with 426) while the protocol version stays the same, so installed daemons silently stop working.
 *
 * 1. Only `runtime/daemon-compat.ts` may decide a daemon is too old; no module throws `upgradeRequired` itself.
 * 2. The daemon-facing protocol types are fingerprinted. Changing them fails this test until a new entry is added to
 *    `REVIEWED`, which forces the question: can an installed daemon ignore the change (keep the protocol), or not
 *    (bump `PROTOCOL_VERSION`, keep the previous version at least deprecated, see `protocol.daemon-compat.ts`)?
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../server/modules/shared/protocol.ts';

const modules = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../server/modules',
);

/** Each reviewed state of the daemon-facing types: its fingerprint, the protocol it belongs to, and why. */
const REVIEWED: readonly {
  readonly fingerprint: string;
  readonly protocol: number;
  readonly note: string;
}[] = [
  {
    fingerprint: 'ac29c8cfc1580cef',
    protocol: 2,
    note: 'NP-150: protocol 2 (negotiation, compatibility in responses); NP-125 configuration is protocol 1 + configurationProtocol.',
  },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : name.endsWith('.ts')
        ? [full]
        : [];
  });
}

/** The source of every exported `Daemon*` / `ClaimedRun*` type in the protocol files the CLI copies. */
function daemonFacingTypes(): string {
  const shared = path.join(modules, 'shared');
  const sources = readdirSync(shared)
    .filter(
      (name) =>
        /^protocol[.a-z0-9-]*\.ts$/u.test(name) && !name.endsWith('-server.ts'),
    )
    .sort();
  const blocks: string[] = [];
  const start =
    /^export (?:interface|type) ((?:Daemon|ClaimedRun)[A-Za-z0-9]*)\b/u;
  for (const name of sources) {
    const lines = readFileSync(path.join(shared, name), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const match = start.exec(lines[index]!);
      if (!match) continue;
      // Up to the closing brace (interfaces) or the `;` outside any brace (type aliases).
      const block: string[] = [];
      let depth = 0;
      for (let end = index; end < lines.length; end += 1) {
        const line = lines[end]!;
        block.push(line);
        depth += (line.match(/\{/gu) ?? []).length;
        depth -= (line.match(/\}/gu) ?? []).length;
        if (
          depth === 0 &&
          (line.startsWith('}') || line.trimEnd().endsWith(';'))
        )
          break;
      }
      blocks.push(
        block
          .join('\n')
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/\/\/.*$/gmu, '')
          .replace(/\s+/gu, ' ')
          .trim(),
      );
    }
  }
  return blocks.sort().join('\n');
}

describe('daemon compatibility guard', () => {
  it('refuses daemons only in runtime/daemon-compat.ts', () => {
    const allowed = new Set([
      path.join(modules, 'shared/errors.ts'),
      path.join(modules, 'shared/http.ts'),
      path.join(modules, 'runtime/daemon-compat.ts'),
    ]);
    const offenders = files(modules).filter(
      (file) =>
        !allowed.has(file) &&
        /['"]upgradeRequired['"]/u.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => path.relative(modules, file))).toEqual([]);
  });

  it('has reviewed every change to the daemon-facing protocol types', () => {
    const fingerprint = createHash('sha256')
      .update(daemonFacingTypes())
      .digest('hex')
      .slice(0, 16);
    const entry = REVIEWED.find((item) => item.fingerprint === fingerprint);
    expect(
      entry,
      `The daemon-facing protocol types changed (fingerprint ${fingerprint}). Decide whether an installed daemon can ignore the change; then add { fingerprint: '${fingerprint}', protocol: <PROTOCOL_VERSION>, note } to REVIEWED.`,
    ).toBeDefined();
    expect(entry!.protocol).toBe(PROTOCOL_VERSION);
  });
});
