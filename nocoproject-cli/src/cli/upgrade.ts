/**
 * `nocoproject upgrade` (NP-150): installs the CLI the server serves and restarts the daemon on it, in one command.
 *
 * 1. `GET /np/daemon/compatibility` names the version; the tarball comes from the configured server address.
 * 2. `npm i -g <server>/assets/cli/nocoproject-cli-<version>.tgz`.
 * 3. Waits until the daemon runs no agent (unless `--force`: stopped runs are retried).
 * 4. The newly installed CLI restarts the daemon: `daemon install` when a boot service is installed (it also points
 *    the service at the new files), otherwise `daemon stop` + `daemon start` when a daemon runs.
 *
 * Refused inside an agent run: the daemon it would restart is the one running that agent.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { DaemonApi, HttpError, daemonCredentials } from '../api/client.js';
import { loadConfig } from '../config.js';
import { withPersonalKey } from '../secrets/index.js';
import { exec, readInstalledService, type Exec } from '../daemon/service.js';
import { cliDownloadPath, compareVersions } from '../protocol.js';
import { sleep } from '../util/backoff.js';
import { CLI_VERSION } from '../version.js';
import { readState, runningPid } from './daemon.js';
import { CliError, EXIT, failAndExit, printJson, printLine } from './output.js';
import { refuseInsideRun } from './user-context.js';

export interface UpgradeOptions {
  readonly to?: string;
  readonly force?: boolean;
  readonly json?: boolean;
  /** Minutes to wait for the daemon to become idle (default 60). */
  readonly wait?: string;
}

export interface UpgradeDeps {
  readonly run: Exec;
  readonly log: (line: string) => void;
  readonly pollMs?: number;
}

async function targetVersion(api: DaemonApi, requested: string | undefined): Promise<string> {
  if (requested) return requested;
  try {
    return (await api.compatibility()).latestVersion;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404)
      throw new CliError('this server does not tell which CLI it serves (it predates `nocoproject upgrade`); pass --to <x.y.z>', EXIT.notFound, 'NO_COMPATIBILITY');
    throw error;
  }
}

async function waitForIdle(home: string, minutes: number, deps: UpgradeDeps): Promise<void> {
  const deadline = Date.now() + minutes * 60_000;
  let announced = false;
  for (;;) {
    const active = runningPid(home) ? Number(readState(home)?.activeRuns ?? 0) : 0;
    if (active === 0) return;
    if (Date.now() > deadline)
      throw new CliError(`the daemon still runs ${active} agent run(s) after ${minutes} minutes; the new CLI is installed, restart later with \`nocoproject daemon install\` (or pass --force)`, EXIT.other, 'DAEMON_BUSY');
    if (!announced) deps.log(`waiting for ${active} agent run(s) to finish before restarting the daemon (--force restarts now)`);
    announced = true;
    await sleep(deps.pollMs ?? 5000);
  }
}

export async function upgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<Record<string, unknown>> {
  try {
    refuseInsideRun();
  } catch {
    throw new CliError('refusing to upgrade from inside an agent run (restarting the daemon would stop this run)', EXIT.auth, 'IN_RUN');
  }
  const cfg = await withPersonalKey(loadConfig());
  if (!cfg.serverUrl || !daemonCredentials(cfg)) throw new CliError('not logged in: run `nocoproject login --server <url> --computer-key-stdin` (add the computer in the app first)', EXIT.auth, 'NOT_LOGGED_IN');
  const version = await targetVersion(new DaemonApi(cfg.serverUrl, daemonCredentials(cfg)!), opts.to);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) throw new CliError(`not a version: ${version}`, EXIT.validation, 'INVALID_VERSION');
  const runningVersion = runningPid(cfg.home) ? readState(cfg.home)?.version : undefined;
  if (compareVersions(version, CLI_VERSION) === 0 && !opts.force && (runningVersion === undefined || runningVersion === CLI_VERSION)) {
    deps.log(`nocoproject-cli ${CLI_VERSION} is what the server serves; nothing to do`);
    return { upgraded: false, version };
  }

  const url = `${cfg.serverUrl.replace(/\/+$/u, '')}${cliDownloadPath(version)}`;
  deps.log(`installing ${url}`);
  const install = await deps.run('npm', ['i', '-g', url], { timeoutMs: 10 * 60_000 });
  if (!install.ok) throw new CliError(`npm i -g ${url} failed: ${install.stderr.trim()}`, EXIT.other, 'NPM_FAILED');
  const root = await deps.run('npm', ['root', '-g']);
  const entry = join(root.stdout.trim(), 'nocoproject-cli', 'dist', 'cli.js');
  if (!root.ok || !existsSync(entry)) throw new CliError(`installed, but the new CLI is not at ${entry}`, EXIT.other, 'NOT_INSTALLED');

  const service = readInstalledService(cfg.home);
  const running = runningPid(cfg.home) !== null;
  let restarted: 'service' | 'daemon' | null = null;
  if (service || running) {
    if (!opts.force) await waitForIdle(cfg.home, Number(opts.wait ?? 60) || 60, deps);
    const cli = (args: string[]) => deps.run(process.execPath, [entry, ...args], { timeoutMs: 3 * 60_000 });
    if (service) {
      const result = await cli(['daemon', 'install', '--force', '--json']);
      if (!result.ok) throw new CliError(`the new CLI could not reinstall the service: ${result.stderr.trim()}`, EXIT.other, 'SERVICE_START_FAILED');
      restarted = 'service';
    } else {
      await cli(['daemon', 'stop', '--json']);
      const result = await cli(['daemon', 'start', '--json']);
      if (!result.ok) throw new CliError(`the new CLI could not start the daemon: ${result.stderr.trim()}`, EXIT.other, 'START_FAILED');
      restarted = 'daemon';
    }
  }
  deps.log(`nocoproject-cli ${version} installed${restarted ? `; daemon restarted (${restarted === 'service' ? `boot service ${service?.label}` : 'background'})` : ''}`);
  if (!service) deps.log('tip: `nocoproject daemon install` starts the daemon at login and keeps it on the installed CLI');
  return { upgraded: true, version, from: CLI_VERSION, url, entry, restarted };
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Install the CLI version the server serves and restart the daemon on it')
    .option('--to <x.y.z>', 'install this version instead of the one the server names')
    .option('--force', 'reinstall even when current, and restart without waiting for agent runs to finish')
    .option('--wait <minutes>', 'how long to wait for running agents before giving up', '60')
    .option('--json', 'JSON output')
    .action(async (opts: UpgradeOptions) => {
      try {
        const result = await upgrade(opts, { run: exec, log: opts.json ? () => undefined : printLine });
        if (opts.json) printJson(result);
      } catch (error) {
        failAndExit(error, Boolean(opts.json));
      }
    });
}
