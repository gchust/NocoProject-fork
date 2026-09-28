// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CLI_VERSION,
  cliInstallCommand,
} from '../../client/pages/np/constants.js';
import cliPlugins from '../../cli/plugins.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('CLI installer served by the application', () => {
  it('ships the version nocoproject-cli declares', () => {
    const cli = JSON.parse(
      readFileSync(path.join(root, '../nocoproject-cli/package.json'), 'utf8'),
    ) as { version: string };
    expect(CLI_VERSION).toBe(cli.version);
  });

  it('installs from the application address, not from GitHub', () => {
    expect(cliInstallCommand('https://project.nocobase.cn/main')).toBe(
      `npm i -g https://project.nocobase.cn/main/assets/cli/nocoproject-cli-${CLI_VERSION}.tgz`,
    );
  });

  it('packs the CLI on every build', () => {
    const hooks = cliPlugins.plugins.flatMap(
      (plugin) => plugin.buildHooks.afterClientBuild ?? [],
    );
    expect(hooks.map((hook) => hook.command)).toContainEqual([
      'bash',
      'scripts/pack-cli.sh',
    ]);
  });
});
