/**
 * Local configuration: `~/.nocoproject/config.json` (0600) plus NOCOPROJECT_* env overrides. The personal API key
 * normally lives in the system keychain instead (`src/secrets`, NP-190).
 *
 * `serverUrl` is the application URL including its mount path, e.g. `http://127.0.0.1:13000/main`.
 * HTTP APIs live at `<serverUrl>/api/np/...` and the realtime socket at `<serverUrl>/ws`.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { parseDuration, parsePositiveInt } from './util/duration.js';
import { registerSecret } from './util/redact.js';

export const StoredConfigSchema = z.object({
  serverUrl: z.string().optional(),
  /** A personal API key in plain text: only where there is no system keychain (NP-190). */
  apiKey: z.string().optional(),
  /** NP-190: the personal API key is in this keychain (`src/secrets`), not in this file. */
  apiKeyStorage: z.enum(['keychain', 'libsecret']).optional(),
  /** NP-150: the computer credential the daemon uses (only `/np/daemon/*`). */
  computerKey: z.string().optional(),
  daemonId: z.string().optional(),
  deviceName: z.string().optional(),
});
export type StoredConfig = z.infer<typeof StoredConfigSchema>;

export interface ResolvedConfig {
  readonly home: string;
  readonly serverUrl: string | undefined;
  /** `NOCOPROJECT_API_KEY` or a plain-text key; a key in the keychain is read by `resolvePersonalKey` (NP-190). */
  readonly apiKey: string | undefined;
  readonly computerKey?: string;
  readonly daemonId: string;
  readonly deviceName: string;
}

export function nocoprojectHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.NOCOPROJECT_HOME || join(homedir(), '.nocoproject');
}

export function configPath(home = nocoprojectHome()): string {
  return join(home, 'config.json');
}

export function ensureHome(home = nocoprojectHome()): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export function readStoredConfig(home = nocoprojectHome()): StoredConfig {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  try {
    return StoredConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new Error(`Invalid config file ${path}: ${(error as Error).message}`);
  }
}

/** Writes config atomically with 0600 permissions. */
export function writeStoredConfig(config: StoredConfig, home = nocoprojectHome()): void {
  ensureHome(home);
  const path = configPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function normalizeServerUrl(url: string): string {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Server URL must be http(s): ${url}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Server URL must not contain credentials, a query string or a fragment.');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Resolves the effective config. Generates and persists `daemonId` on first use so the
 * same machine always registers as the same daemon.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const home = nocoprojectHome(env);
  const stored = readStoredConfig(home);
  let daemonId = env.NOCOPROJECT_DAEMON_ID || stored.daemonId;
  if (!daemonId) {
    daemonId = randomUUID();
    writeStoredConfig({ ...stored, daemonId }, home);
  }
  const rawUrl = env.NOCOPROJECT_SERVER_URL || stored.serverUrl;
  const apiKey = env.NOCOPROJECT_API_KEY || stored.apiKey;
  const computerKey = env.NOCOPROJECT_COMPUTER_KEY || stored.computerKey;
  registerSecret(apiKey);
  registerSecret(computerKey);
  return {
    home,
    serverUrl: rawUrl ? normalizeServerUrl(rawUrl) : undefined,
    apiKey,
    ...(computerKey ? { computerKey } : {}),
    daemonId,
    deviceName: env.NOCOPROJECT_DEVICE_NAME || stored.deviceName || hostname(),
  };
}

export interface DaemonSettings {
  readonly maxConcurrent: number;
  readonly pollIntervalMs: number | undefined;
  readonly idleWatchdogMs: number;
  readonly workspacesRoot: string;
  readonly providers: readonly string[] | undefined;
}

export interface DaemonSettingsOverrides {
  readonly maxConcurrent?: number;
  readonly providers?: readonly string[];
  readonly pollIntervalMs?: number;
}

export function loadDaemonSettings(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  overrides: DaemonSettingsOverrides = {},
): DaemonSettings {
  const providers = overrides.providers ?? splitList(env.NOCOPROJECT_PROVIDERS);
  const envPoll = env.NOCOPROJECT_POLL_INTERVAL ? parseDuration(env.NOCOPROJECT_POLL_INTERVAL, 0) : 0;
  return {
    maxConcurrent: overrides.maxConcurrent ?? parsePositiveInt(env.NOCOPROJECT_MAX_CONCURRENT, 20),
    pollIntervalMs: overrides.pollIntervalMs ?? (envPoll > 0 ? envPoll : undefined),
    idleWatchdogMs: parseDuration(env.NOCOPROJECT_AGENT_IDLE_WATCHDOG, 2 * 3_600_000),
    workspacesRoot: env.NOCOPROJECT_WORKSPACES_ROOT || join(home, 'workspaces'),
    providers: providers && providers.length > 0 ? providers : undefined,
  };
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
