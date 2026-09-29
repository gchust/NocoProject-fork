/**
 * The daemon's boot service (NP-150): a launchd agent on macOS, a systemd user unit on Linux. It always runs the CLI
 * that installed it (`process.execPath` + the real path of the entry), so `npm i -g` followed by `daemon install`
 * never leaves an old copy running, and the PATH of the installing shell (launchd's default PATH finds neither
 * `claude` nor `codex`). What was installed is recorded in `<home>/service.json`.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SERVICE_LABEL = 'ai.nocobase.nocoproject-daemon';
const SYSTEMD_UNIT = 'nocoproject-daemon';

export type ServiceKind = 'launchd' | 'systemd';

export interface ServiceSpec {
  readonly kind: ServiceKind;
  /** launchd label, or the systemd unit name without `.service`. */
  readonly label: string;
  readonly execPath: string;
  readonly entry: string;
  readonly home: string;
  readonly path: string;
  readonly logFile: string;
  /** Extra `daemon start` options (`--providers`, `--max-concurrent`). */
  readonly startArgs: readonly string[];
  /** Daemon settings from the environment (`SERVICE_ENV`), kept for the service. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The daemon settings a service keeps from the installing environment. Never the API key or server URL (the service
 * reads `config.json`) and never a run's variables.
 */
export const SERVICE_ENV = [
  'NOCOPROJECT_DEVICE_NAME',
  'NOCOPROJECT_DAEMON_ID',
  'NOCOPROJECT_PROVIDERS',
  'NOCOPROJECT_MAX_CONCURRENT',
  'NOCOPROJECT_POLL_INTERVAL',
  'NOCOPROJECT_AGENT_IDLE_WATCHDOG',
  'NOCOPROJECT_WORKSPACES_ROOT',
] as const;

/** `<home>/service.json`. */
export interface InstalledService {
  readonly kind: ServiceKind;
  readonly label: string;
  readonly file: string;
  readonly execPath: string;
  readonly entry: string;
  readonly version: string;
  readonly installedAt: string;
  /** Kept so `daemon install` (and `upgrade`) without options reinstall the same service. */
  readonly startArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export function serviceKind(platform: NodeJS.Platform = process.platform): ServiceKind | null {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return null;
}

/**
 * The default home gets the plain name (replacing a hand-written service of the same name); any other home a suffix,
 * so a second installation (or a test) never touches the first one.
 */
export function serviceLabel(kind: ServiceKind, home: string, defaultHome = join(homedir(), '.nocoproject')): string {
  const base = kind === 'launchd' ? SERVICE_LABEL : SYSTEMD_UNIT;
  if (home === defaultHome) return base;
  return `${base}-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
}

export function serviceFile(kind: ServiceKind, label: string, userHome = homedir()): string {
  return kind === 'launchd' ? join(userHome, 'Library', 'LaunchAgents', `${label}.plist`) : join(userHome, '.config', 'systemd', 'user', `${label}.service`);
}

/**
 * A `node` on PATH that is the same binary as `execPath`, so the service survives a version upgrade of the Node
 * package (Homebrew's `.../Cellar/node@24/24.21.0/bin/node` behind `/opt/homebrew/opt/node@24/bin/node`).
 */
export function stableNodePath(execPath: string, path: string | undefined): string {
  const target = realEntry(execPath);
  for (const dir of (path ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'node');
    if (candidate !== execPath && existsSync(candidate) && realEntry(candidate) === target && !candidate.includes('/.nocoproject/')) return candidate;
  }
  return execPath;
}

export function realEntry(entry: string): string {
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function programArgs(spec: ServiceSpec): string[] {
  return [spec.execPath, spec.entry, 'daemon', 'start', '--foreground', ...spec.startArgs];
}

function serviceEnv(spec: ServiceSpec): [string, string][] {
  return [['PATH', spec.path], ['NOCOPROJECT_HOME', spec.home], ...Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))];
}

export function launchdPlist(spec: ServiceSpec): string {
  const args = programArgs(spec);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`nocoproject daemon install\`; run it again instead of editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${serviceEnv(spec)
  .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

function quoteSystemd(value: string): string {
  return /[\s"\\]/u.test(value) ? `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"` : value;
}

export function systemdUnit(spec: ServiceSpec): string {
  const args = programArgs(spec);
  return `# Written by \`nocoproject daemon install\`; run it again instead of editing this file.
[Unit]
Description=NocoProject agent daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${args.map(quoteSystemd).join(' ')}
${serviceEnv(spec)
  .map(([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`)
  .join('\n')}
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=40
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}

[Install]
WantedBy=default.target
`;
}

export function renderService(spec: ServiceSpec): string {
  return spec.kind === 'launchd' ? launchdPlist(spec) : systemdUnit(spec);
}

/** Lines only in `before` (`-`) and only in `after` (`+`): enough to show what an overwrite changes. */
export function lineDiff(before: string, after: string): string[] {
  const old = before.split('\n');
  const next = after.split('\n');
  return [...old.filter((line) => !next.includes(line)).map((line) => `- ${line}`), ...next.filter((line) => !old.includes(line)).map((line) => `+ ${line}`)];
}

export type Exec = (file: string, args: readonly string[], opts?: { readonly timeoutMs?: number }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export const exec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: opts?.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr || (error?.message ?? '')) }),
    );
  });

function uid(): number {
  return process.getuid?.() ?? 0;
}

/** Stops and unloads the service if it is loaded (no error when it is not). */
export async function unloadService(kind: ServiceKind, label: string, run: Exec = exec): Promise<void> {
  if (kind === 'launchd') await run('launchctl', ['bootout', `gui/${uid()}/${label}`]);
  else await run('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
}

/** Loads and starts the service from its file; returns the manager's error text when it fails. */
export async function loadService(kind: ServiceKind, label: string, file: string, run: Exec = exec): Promise<string | null> {
  if (kind === 'launchd') {
    // Right after a bootout launchd may still be tearing the old job down ("Input/output error"): retry briefly.
    let result = await run('launchctl', ['bootstrap', `gui/${uid()}`, file]);
    for (let attempt = 0; !result.ok && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await run('launchctl', ['bootstrap', `gui/${uid()}`, file]);
    }
    return result.ok ? null : result.stderr.trim() || 'launchctl bootstrap failed';
  }
  const reload = await run('systemctl', ['--user', 'daemon-reload']);
  if (!reload.ok) return reload.stderr.trim() || 'systemctl --user daemon-reload failed';
  const enable = await run('systemctl', ['--user', 'enable', '--now', `${label}.service`]);
  return enable.ok ? null : enable.stderr.trim() || 'systemctl --user enable failed';
}

/** Restarts a loaded service in place (the file did not change). */
export async function restartService(kind: ServiceKind, label: string, run: Exec = exec): Promise<string | null> {
  const result = kind === 'launchd' ? await run('launchctl', ['kickstart', '-k', `gui/${uid()}/${label}`]) : await run('systemctl', ['--user', 'restart', `${label}.service`]);
  return result.ok ? null : result.stderr.trim() || 'restart failed';
}

export function serviceRecordPath(home: string): string {
  return join(home, 'service.json');
}

export function readInstalledService(home: string): InstalledService | null {
  try {
    return JSON.parse(readFileSync(serviceRecordPath(home), 'utf8')) as InstalledService;
  } catch {
    return null;
  }
}

export function writeServiceFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o644 });
}

export function writeInstalledService(home: string, record: InstalledService): void {
  writeFileSync(serviceRecordPath(home), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function removeInstalledService(home: string, file: string | null): void {
  if (file && existsSync(file)) rmSync(file);
  rmSync(serviceRecordPath(home), { force: true });
}

/**
 * Warnings for `daemon start` / `daemon status`: the installed service runs a different CLI than this command, or the
 * running daemon is another version.
 */
export function serviceWarnings(
  current: { readonly execPath: string; readonly entry: string | null; readonly version: string },
  installed: InstalledService | null,
  running: { readonly version?: unknown; readonly entry?: unknown } | null,
): string[] {
  const warnings: string[] = [];
  if (installed && current.entry && (realEntry(installed.entry) !== realEntry(current.entry) || realEntry(installed.execPath) !== realEntry(current.execPath)))
    warnings.push(`the boot service ${installed.label} runs ${installed.execPath} ${installed.entry} (${installed.version}), not this CLI (${current.version}); run \`nocoproject daemon install\` to point it here`);
  if (running && typeof running.version === 'string' && running.version !== current.version)
    warnings.push(`the running daemon is nocoproject-cli ${running.version}, this command is ${current.version}; restart it (\`nocoproject daemon install\`, or \`nocoproject daemon stop && nocoproject daemon start\`)`);
  return warnings;
}
