/**
 * `nocoproject daemon install|uninstall` (NP-150): writes the boot service for the CLI that runs this command and
 * (re)starts the daemon through it. See `daemon/service.ts`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import {
  exec,
  lineDiff,
  loadService,
  readInstalledService,
  realEntry,
  removeInstalledService,
  renderService,
  serviceFile,
  serviceKind,
  serviceLabel,
  unloadService,
  writeInstalledService,
  writeServiceFile,
  type Exec,
  type ServiceSpec,
} from '../daemon/service.js';
import { CLI_VERSION } from '../version.js';
import { CliError, EXIT, failAndExit, printJson, printLine } from './output.js';
import { paths, readState, runningPid, stopRunning } from './daemon.js';
import { refuseInsideRun } from './user-context.js';

export interface InstallOptions {
  readonly start?: boolean;
  readonly force?: boolean;
  readonly json?: boolean;
}

/** Refuses to restart a daemon that is running agents, unless forced (they are then retried elsewhere). */
export function requireIdle(home: string, force: boolean | undefined): void {
  if (force || !runningPid(home)) return;
  const active = Number(readState(home)?.activeRuns ?? 0);
  if (active > 0)
    throw new CliError(`the daemon is running ${active} agent run(s); try again when it is idle, or pass --force (the runs are stopped and retried)`, EXIT.other, 'DAEMON_BUSY');
}

export async function installService(opts: InstallOptions, run: Exec = exec, log: (line: string) => void = printLine): Promise<Record<string, unknown>> {
  refuseInsideRunForService();
  const cfg = loadConfig();
  if (!cfg.serverUrl || !cfg.apiKey) throw new CliError('not logged in: run `nocoproject login --server <url> --api-key-stdin` first', EXIT.auth, 'NOT_LOGGED_IN');
  const kind = serviceKind();
  if (!kind) throw new CliError(`no boot service support on ${process.platform}; run \`nocoproject daemon start\` instead`, EXIT.validation, 'UNSUPPORTED_PLATFORM');
  const entry = process.argv[1];
  if (!entry) throw new CliError('cannot tell which CLI is running', EXIT.other, 'NO_ENTRY');
  requireIdle(cfg.home, opts.force);
  const label = serviceLabel(kind, cfg.home);
  const file = serviceFile(kind, label);
  const p = paths(cfg.home);
  mkdirSync(p.logDir, { recursive: true, mode: 0o700 });
  const spec: ServiceSpec = { kind, label, execPath: process.execPath, entry: realEntry(entry), home: cfg.home, path: process.env.PATH ?? '/usr/bin:/bin', logFile: p.log };
  const content = renderService(spec);
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (previous !== null && previous !== content) {
    log(`replacing ${file}:`);
    for (const line of lineDiff(previous, content)) log(`  ${line}`);
  }
  // Stop whatever runs now: the loaded service (possibly a hand-written one of the same name), then a daemon started by hand.
  await unloadService(kind, label, run);
  const stopped = await stopRunning(cfg.home);
  if (stopped) log(`stopped the running daemon (pid ${stopped.pid})`);
  writeServiceFile(file, content);
  writeInstalledService(cfg.home, { kind, label, file, execPath: spec.execPath, entry: spec.entry, version: CLI_VERSION, installedAt: new Date().toISOString() });
  let started = false;
  if (opts.start !== false) {
    const error = await loadService(kind, label, file, run);
    if (error) throw new CliError(`wrote ${file} but could not start it: ${error}`, EXIT.other, 'SERVICE_START_FAILED');
    started = true;
  }
  if (kind === 'systemd') log('tip: `loginctl enable-linger $USER` keeps the daemon running while you are logged out');
  return { kind, label, file, entry: spec.entry, execPath: spec.execPath, version: CLI_VERSION, started, log: p.log };
}

export async function uninstallService(run: Exec = exec): Promise<Record<string, unknown>> {
  refuseInsideRunForService();
  const cfg = loadConfig();
  const kind = serviceKind();
  if (!kind) throw new CliError(`no boot service support on ${process.platform}`, EXIT.validation, 'UNSUPPORTED_PLATFORM');
  const installed = readInstalledService(cfg.home);
  const label = installed?.label ?? serviceLabel(kind, cfg.home);
  const file = installed?.file ?? serviceFile(kind, label);
  await unloadService(kind, label, run);
  const existed = existsSync(file);
  removeInstalledService(cfg.home, file);
  if (kind === 'systemd') await run('systemctl', ['--user', 'daemon-reload']);
  return { kind, label, file, removed: existed };
}

/** The daemon of an agent run is the one that runs it: restarting it from inside kills the run. */
function refuseInsideRunForService(): void {
  try {
    refuseInsideRun();
  } catch {
    throw new CliError('refusing to change the daemon from inside an agent run (it would stop this run)', EXIT.auth, 'IN_RUN');
  }
}

export function registerServiceCommands(daemon: Command): void {
  daemon
    .command('install')
    .description('Install the daemon as a boot service (launchd / systemd --user) running this CLI, and (re)start it')
    .option('--no-start', 'write the service without starting it')
    .option('--force', 'restart even while agent runs are active (they are retried)')
    .option('--json', 'JSON output')
    .action(async (opts: InstallOptions) => {
      try {
        const result = await installService(opts, exec, opts.json ? () => undefined : printLine);
        if (opts.json) printJson(result);
        else printLine(`installed ${String(result.label)} → ${String(result.entry)} (${CLI_VERSION})${result.started ? '; daemon started' : ''}; logs: ${String(result.log)}`);
      } catch (error) {
        failAndExit(error, Boolean(opts.json));
      }
    });
  daemon
    .command('uninstall')
    .description('Stop and remove the boot service')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = await uninstallService();
        if (opts.json) printJson(result);
        else printLine(result.removed ? `removed ${String(result.file)}` : `no service file at ${String(result.file)}`);
      } catch (error) {
        failAndExit(error, Boolean(opts.json));
      }
    });
}
