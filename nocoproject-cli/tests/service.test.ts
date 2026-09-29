/**
 * NP-150: the boot service (`daemon install` / `uninstall`) and `nocoproject upgrade`, with the service manager and
 * npm replaced by a recording `Exec`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installService, uninstallService } from '../src/cli/service.js';
import { upgrade } from '../src/cli/upgrade.js';
import {
  launchdPlist,
  lineDiff,
  readInstalledService,
  serviceFile,
  serviceKind,
  serviceLabel,
  serviceWarnings,
  systemdUnit,
  type Exec,
  type ServiceSpec,
} from '../src/daemon/service.js';
import { CLI_VERSION } from '../src/version.js';
import { API_KEY, MockServer } from './helpers/mock-server.js';

const SPEC: ServiceSpec = {
  kind: 'launchd',
  label: 'ai.nocobase.nocoproject-daemon',
  execPath: '/opt/homebrew/opt/node@24/bin/node',
  entry: '/opt/homebrew/lib/node_modules/nocoproject-cli/dist/cli.js',
  home: '/Users/me/.nocoproject',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  logFile: '/Users/me/.nocoproject/logs/daemon.log',
};

describe('service definitions', () => {
  it('writes a launchd agent that runs this CLI with the installing PATH', () => {
    const plist = launchdPlist(SPEC);
    expect(plist).toContain(`<string>${SPEC.execPath}</string>\n    <string>${SPEC.entry}</string>\n    <string>daemon</string>\n    <string>start</string>\n    <string>--foreground</string>`);
    expect(plist).toContain(`<key>PATH</key>\n    <string>${SPEC.path}</string>`);
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>${SPEC.logFile}</string>`);
  });

  it('writes a systemd user unit that restarts the daemon', () => {
    const unit = systemdUnit({ ...SPEC, kind: 'systemd', label: 'nocoproject-daemon', entry: '/home/me/.npm global/lib/node_modules/nocoproject-cli/dist/cli.js' });
    expect(unit).toContain(`ExecStart=${SPEC.execPath} "/home/me/.npm global/lib/node_modules/nocoproject-cli/dist/cli.js" daemon start --foreground`);
    expect(unit).toContain(`Environment=PATH=${SPEC.path}`);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('names the default home plainly and any other home with a suffix', () => {
    expect(serviceLabel('launchd', '/Users/me/.nocoproject', '/Users/me/.nocoproject')).toBe('ai.nocobase.nocoproject-daemon');
    expect(serviceLabel('systemd', '/tmp/x', '/Users/me/.nocoproject')).toMatch(/^nocoproject-daemon-[0-9a-f]{8}$/);
  });

  it('shows what an overwrite changes', () => {
    expect(lineDiff('a\nold\nc', 'a\nnew\nc')).toEqual(['- old', '+ new']);
  });

  it('warns when the service or the running daemon is another CLI', () => {
    const current = { execPath: '/node', entry: '/new/cli.js', version: '0.5.0' };
    const installed = { kind: 'launchd' as const, label: 'l', file: 'f', execPath: '/node', entry: '/repo/dist/cli.js', version: '0.3.0', installedAt: '' };
    expect(serviceWarnings(current, installed, { version: '0.3.0' })).toHaveLength(2);
    expect(serviceWarnings(current, { ...installed, entry: '/new/cli.js' }, { version: '0.5.0' })).toEqual([]);
  });
});

describe('daemon install / uninstall / upgrade', () => {
  let home: string;
  let userHome: string;
  let calls: { file: string; args: readonly string[] }[];
  const saved = { ...process.env };
  const record: Exec = async (file, args) => {
    calls.push({ file, args });
    return { ok: true, stdout: '', stderr: '' };
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ncp-service-'));
    userHome = mkdtempSync(join(tmpdir(), 'ncp-user-'));
    calls = [];
    process.env.HOME = userHome;
    process.env.NOCOPROJECT_HOME = home;
    process.env.NOCOPROJECT_SERVER_URL = 'http://127.0.0.1:1/main';
    process.env.NOCOPROJECT_API_KEY = API_KEY;
    delete process.env.NOCOPROJECT_TOKEN;
    delete process.env.NOCOPROJECT_RUN_ID;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  const kind = serviceKind();

  it.skipIf(!kind)('installs the service for this CLI and removes it again', async () => {
    const result = await installService({}, record, () => undefined);
    const label = serviceLabel(kind!, home);
    const file = serviceFile(kind!, label, userHome);
    expect(result).toMatchObject({ kind, label, file, started: true, version: CLI_VERSION });
    const content = readFileSync(file, 'utf8');
    expect(content).toContain(process.execPath);
    expect(content).toContain(`NOCOPROJECT_HOME`);
    expect(readInstalledService(home)).toMatchObject({ label, file, execPath: process.execPath, version: CLI_VERSION });
    const commands = calls.map((c) => `${c.file} ${c.args.join(' ')}`);
    if (kind === 'launchd') {
      expect(commands[0]).toMatch(new RegExp(`^launchctl bootout gui/\\d+/${label}$`));
      expect(commands[1]).toMatch(new RegExp(`^launchctl bootstrap gui/\\d+ ${file}$`));
    } else {
      expect(commands).toEqual([`systemctl --user disable --now ${label}.service`, 'systemctl --user daemon-reload', `systemctl --user enable --now ${label}.service`]);
    }

    calls = [];
    await expect(uninstallService(record)).resolves.toMatchObject({ removed: true });
    expect(readInstalledService(home)).toBeNull();
  });

  it('refuses inside an agent run and while agents run', async () => {
    process.env.NOCOPROJECT_TOKEN = 'npr_x';
    await expect(installService({}, record, () => undefined)).rejects.toMatchObject({ code: 'IN_RUN' });
    await expect(upgrade({}, { run: record, log: () => undefined })).rejects.toMatchObject({ code: 'IN_RUN' });
    delete process.env.NOCOPROJECT_TOKEN;
    // This test process plays the running daemon.
    writeFileSync(join(home, 'daemon.pid'), `${process.pid}\n`);
    writeFileSync(join(home, 'daemon.state.json'), JSON.stringify({ activeRuns: 2, version: CLI_VERSION }));
    await expect(installService({}, record, () => undefined)).rejects.toMatchObject({ code: 'DAEMON_BUSY' });
    expect(calls).toEqual([]);
  });

  it('installs the served version and restarts the boot service with the new CLI once idle', async () => {
    const mock = new MockServer();
    mock.latestVersion = '9.9.9';
    await mock.start();
    try {
      process.env.NOCOPROJECT_SERVER_URL = mock.url;
      const npmRoot = mkdtempSync(join(tmpdir(), 'ncp-npm-'));
      mkdirSync(join(npmRoot, 'nocoproject-cli', 'dist'), { recursive: true });
      writeFileSync(join(npmRoot, 'nocoproject-cli', 'dist', 'cli.js'), '');
      writeFileSync(join(home, 'service.json'), JSON.stringify({ kind: 'launchd', label: 'x', file: '/f', execPath: '/n', entry: '/e', version: CLI_VERSION, installedAt: '' }));
      writeFileSync(join(home, 'daemon.pid'), `${process.pid}\n`);
      writeFileSync(join(home, 'daemon.state.json'), JSON.stringify({ activeRuns: 1, version: CLI_VERSION }));
      const logs: string[] = [];
      const run: Exec = async (file, args) => {
        calls.push({ file, args });
        return { ok: true, stdout: file === 'npm' && args[0] === 'root' ? `${npmRoot}\n` : '', stderr: '' };
      };
      const pending = upgrade({}, { run, log: (line) => logs.push(line), pollMs: 20 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Still waiting for the agent run: npm has run, the daemon not restarted yet.
      expect(calls.map((c) => c.file)).toEqual(['npm', 'npm']);
      writeFileSync(join(home, 'daemon.state.json'), JSON.stringify({ activeRuns: 0, version: CLI_VERSION }));
      const result = await pending;
      expect(calls[0]).toEqual({ file: 'npm', args: ['i', '-g', `${mock.url}/assets/cli/nocoproject-cli-9.9.9.tgz`] });
      expect(calls[2]).toEqual({ file: process.execPath, args: [join(npmRoot, 'nocoproject-cli', 'dist', 'cli.js'), 'daemon', 'install', '--force', '--json'] });
      expect(result).toMatchObject({ upgraded: true, version: '9.9.9', restarted: 'service' });
      expect(logs.join('\n')).toContain('waiting for 1 agent run(s)');
    } finally {
      await mock.stop();
    }
  });

  it('does nothing when the served version is the running one', async () => {
    const mock = new MockServer();
    mock.latestVersion = CLI_VERSION;
    await mock.start();
    try {
      process.env.NOCOPROJECT_SERVER_URL = mock.url;
      await expect(upgrade({}, { run: record, log: () => undefined })).resolves.toMatchObject({ upgraded: false });
      expect(calls).toEqual([]);
    } finally {
      await mock.stop();
    }
  });
});
