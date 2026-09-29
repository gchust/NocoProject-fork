/**
 * `nocoproject daemon start|stop|status|logs|install|uninstall` (install / uninstall in `service.ts`).
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, watchFile, writeFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { HttpError, daemonCredentials } from '../api/client.js';
import { ensureHome, loadConfig, loadDaemonSettings } from '../config.js';
import { Daemon } from '../daemon/lifecycle.js';
import { sleep } from '../util/backoff.js';
import { createLogger } from '../util/log.js';
import { CliError, EXIT, failAndExit, printJson, printLine } from './output.js';
import type { CredentialProblem, UpgradeRequired } from '../daemon/lifecycle.js';
import { readInstalledService, realEntry, serviceWarnings } from '../daemon/service.js';
import { PROTOCOL_VERSION, upgradeCommand, type DaemonCompatibility } from '../protocol.js';
import { CLI_VERSION } from '../version.js';
import { registerServiceCommands } from './service.js';

export const paths = (home: string) => ({
  pid: join(home, 'daemon.pid'),
  state: join(home, 'daemon.state.json'),
  logDir: join(home, 'logs'),
  log: join(home, 'logs', 'daemon.log'),
});

function readPid(home: string): number | null {
  try {
    const pid = Number(readFileSync(paths(home).pid, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runningPid(home: string): number | null {
  const pid = readPid(home);
  return pid && alive(pid) ? pid : null;
}

/** The running daemon's `daemon.state.json`, or null. */
export function readState(home: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(paths(home).state, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Warnings when the boot service or the running daemon is not this CLI (printed to stderr by start and status). */
export function currentWarnings(home: string): string[] {
  const running = runningPid(home) ? readState(home) : null;
  return serviceWarnings({ execPath: process.execPath, entry: process.argv[1] ? realEntry(process.argv[1]) : null, version: CLI_VERSION }, readInstalledService(home), running);
}

interface StartOpts {
  foreground?: boolean;
  providers?: string;
  maxConcurrent?: string;
  json?: boolean;
}

function settingsFrom(home: string, opts: StartOpts) {
  const providers = opts.providers?.split(',').map((s) => s.trim()).filter(Boolean);
  const maxConcurrent = opts.maxConcurrent ? Number(opts.maxConcurrent) : undefined;
  if (maxConcurrent !== undefined && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)) {
    throw new CliError('--max-concurrent must be a positive integer', EXIT.validation, 'INVALID_OPTION');
  }
  return loadDaemonSettings(home, process.env, { providers, maxConcurrent });
}

async function startForeground(opts: StartOpts): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.serverUrl || !daemonCredentials(cfg)) throw new CliError('not logged in: run `nocoproject login --server <url> --computer-key-stdin` (add the computer in the app first)', EXIT.auth, 'NOT_LOGGED_IN');
  ensureHome(cfg.home);
  const existing = runningPid(cfg.home);
  if (existing && existing !== process.pid) throw new CliError(`daemon already running (pid ${existing})`, EXIT.other, 'ALREADY_RUNNING');
  const logger = createLogger({ scope: 'daemon' });
  const daemon = new Daemon({ config: { ...cfg, serverUrl: cfg.serverUrl }, settings: settingsFrom(cfg.home, opts), logger });
  const p = paths(cfg.home);
  writeFileSync(p.pid, `${process.pid}\n`, { mode: 0o600 });
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info(`received ${signal}`);
    await daemon.stop();
    try {
      if (readPid(cfg.home) === process.pid) unlinkSync(p.pid);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  try {
    logger.info('starting', { serverUrl: cfg.serverUrl, daemonId: cfg.daemonId, device: cfg.deviceName });
    await daemon.start();
  } catch (error) {
    try {
      unlinkSync(p.pid);
    } catch {
      /* ignore */
    }
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new CliError(`server rejected the API key (${error.status}); run nocoproject login again`, EXIT.auth, 'AUTH_FAILED');
    }
    throw error;
  }
}

async function startBackground(opts: StartOpts): Promise<void> {
  const cfg = loadConfig();
  const service = readInstalledService(cfg.home);
  if (service)
    process.stderr.write(`warning: the boot service ${service.label} is installed; it starts the daemon itself (use \`nocoproject daemon install\` to restart it)\n`);
  for (const warning of currentWarnings(cfg.home)) process.stderr.write(`warning: ${warning}\n`);
  if (!cfg.serverUrl || !daemonCredentials(cfg)) throw new CliError('not logged in: run `nocoproject login --server <url> --computer-key-stdin` (add the computer in the app first)', EXIT.auth, 'NOT_LOGGED_IN');
  const p = paths(cfg.home);
  const existing = runningPid(cfg.home);
  if (existing) throw new CliError(`daemon already running (pid ${existing})`, EXIT.other, 'ALREADY_RUNNING');
  mkdirSync(p.logDir, { recursive: true, mode: 0o700 });
  const fd = openSync(p.log, 'a', 0o600);
  const args = [process.argv[1] ?? '', 'daemon', 'start', '--foreground'];
  if (opts.providers) args.push('--providers', opts.providers);
  if (opts.maxConcurrent) args.push('--max-concurrent', opts.maxConcurrent);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env });
  child.unref();
  closeSync(fd);
  await sleep(1500);
  if (!child.pid || !alive(child.pid)) throw new CliError(`daemon exited during startup; see ${p.log}`, EXIT.other, 'START_FAILED');
  const result = { pid: child.pid, log: p.log };
  if (opts.json) printJson(result);
  else printLine(`daemon started (pid ${child.pid}); logs: ${p.log}`);
}

/** Stops the daemon of `home` (SIGTERM, SIGKILL after 30 seconds); null when none runs. */
export async function stopRunning(home: string): Promise<{ pid: number; forced: boolean } | null> {
  const pid = runningPid(home);
  if (!pid) return null;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 30_000;
  while (alive(pid) && Date.now() < deadline) await sleep(200);
  const forced = alive(pid);
  if (forced) process.kill(pid, 'SIGKILL');
  return { pid, forced };
}

async function stopDaemon(json: boolean): Promise<void> {
  const home = loadConfig().home;
  const service = readInstalledService(home);
  if (service && runningPid(home))
    process.stderr.write(`warning: the boot service ${service.label} will start the daemon again; \`nocoproject daemon uninstall\` stops it for good\n`);
  const stopped = await stopRunning(home);
  if (!stopped) {
    if (json) printJson({ stopped: false, reason: 'not running' });
    else printLine('daemon is not running');
    return;
  }
  if (json) printJson({ stopped: true, pid: stopped.pid, forced: stopped.forced });
  else printLine(`daemon stopped (pid ${stopped.pid}${stopped.forced ? ', forced' : ''})`);
}

function statusDaemon(json: boolean): void {
  const home = loadConfig().home;
  const pid = runningPid(home);
  const p = paths(home);
  const state = readState(home);
  const service = readInstalledService(home);
  const warnings = currentWarnings(home);
  const cli = { version: CLI_VERSION, protocolVersion: PROTOCOL_VERSION };
  const result = { running: pid !== null, pid, log: p.log, cli, service, warnings, ...(pid && state ? { state } : {}) };
  if (json) return printJson(result);
  printLine(`nocoproject-cli ${CLI_VERSION} (protocol ${PROTOCOL_VERSION})`);
  if (service) printLine(`boot service: ${service.label} (${service.kind}) → ${service.entry}`);
  else printLine('boot service: not installed (`nocoproject daemon install`)');
  for (const warning of warnings) printLine(`  !! ${warning}`);
  if (!pid) return printLine('daemon is not running');
  printLine(`daemon running (pid ${pid}${typeof state?.version === 'string' ? `, nocoproject-cli ${state.version}` : ''})`);
  if (state) {
    const runtimes = (state.runtimes as { provider: string; id: string; version: string }[] | undefined) ?? [];
    printLine(`server: ${String(state.serverUrl)}   socket: ${String(state.socket)}   active runs: ${String(state.activeRuns)}/${String(state.maxConcurrent)}`);
    if (typeof state.entry === 'string') printLine(`running: ${String(state.execPath)} ${state.entry}`);
    for (const r of runtimes) printLine(`  runtime ${r.provider} ${r.version} (${r.id})`);
    const compatibility = state.compatibility as DaemonCompatibility | null | undefined;
    if (compatibility)
      printLine(`server: accepts protocols ${compatibility.protocols.min}-${compatibility.protocols.current}, CLI ${compatibility.minVersion} or later, latest ${compatibility.latestVersion} (this daemon: ${compatibility.status})`);
    if (state.credential === 'personalKey')
      printLine('  credential: your personal API key; add this computer in the app and run `nocoproject login --server <url> --computer-key-stdin`');
    const problem = state.credentialProblem as CredentialProblem | null | undefined;
    if (problem) printLine(`  !! computer credential refused (${problem.code}); claiming is paused. Add the computer again in the app, then run: ${problem.command}`);
    const upgrade = state.upgradeRequired as UpgradeRequired | null | undefined;
    if (upgrade) printLine(`  !! upgrade required (${upgrade.reason}); claiming is paused. Run: ${upgrade.command}`);
    else if (state.protocolMismatch) printLine('  !! protocol mismatch: upgrade nocoproject-cli');
    else if (compatibility?.updateAvailable) printLine(`  a newer CLI is available (${compatibility.latestVersion}): ${upgradeCommand(String(state.serverUrl), CLI_VERSION, compatibility.latestVersion)}`);
  }
  printLine(`logs: ${p.log}`);
}

async function logsDaemon(lines: number, follow: boolean): Promise<void> {
  const file = paths(loadConfig().home).log;
  process.stderr.write(`Reading ${file}\n`);
  if (!existsSync(file)) throw new CliError(`no log file at ${file}`, EXIT.notFound, 'NO_LOG');
  const text = readFileSync(file, 'utf8');
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  process.stdout.write(all.slice(-lines).join('\n') + (all.length ? '\n' : ''));
  if (!follow) return;
  let offset = statSync(file).size;
  watchFile(file, { interval: 500 }, (curr) => {
    if (curr.size < offset) offset = 0;
    if (curr.size === offset) return;
    createReadStream(file, { start: offset, end: curr.size - 1 }).pipe(process.stdout, { end: false });
    offset = curr.size;
  });
  await new Promise(() => undefined);
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('Run the local agent daemon');
  daemon
    .command('start')
    .description('Start the daemon (in the background unless --foreground)')
    .option('--foreground', 'run in the foreground and log to stderr')
    .option('--providers <list>', 'comma-separated providers to register (claude,opencode,codex,echo)')
    .option('--max-concurrent <n>', 'maximum concurrent runs (default 20)')
    .option('--json', 'JSON output')
    .action(async (opts: StartOpts) => {
      try {
        if (opts.foreground) await startForeground(opts);
        else await startBackground(opts);
      } catch (error) {
        failAndExit(error, Boolean(opts.json));
      }
    });
  daemon
    .command('stop')
    .description('Stop the background daemon')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => stopDaemon(Boolean(opts.json)).catch((e: unknown) => failAndExit(e, Boolean(opts.json))));
  daemon
    .command('status')
    .description('Show daemon status')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) => {
      try {
        statusDaemon(Boolean(opts.json));
      } catch (error) {
        failAndExit(error, Boolean(opts.json));
      }
    });
  daemon
    .command('logs')
    .description('Print the daemon log')
    .option('-n, --lines <n>', 'number of lines', '50')
    .option('-f, --follow', 'keep printing new lines')
    .option('--json', 'JSON output (errors only)')
    .action(async (opts: { lines: string; follow?: boolean; json?: boolean }) =>
      logsDaemon(Math.max(1, Number(opts.lines) || 50), Boolean(opts.follow)).catch((e: unknown) => failAndExit(e, Boolean(opts.json))),
    );
  registerServiceCommands(daemon);
}
