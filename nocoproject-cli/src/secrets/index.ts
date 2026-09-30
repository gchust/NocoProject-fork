/**
 * The personal API key's storage (NP-190). `NOCOPROJECT_API_KEY` wins; otherwise the key lives in the system keychain
 * (`config.json` only says `apiKeyStorage`), or, where there is none, in plain text in `config.json` (0600). A plain
 * key left by an older CLI moves into the keychain on the next `login` or `nocoproject user …`.
 *
 * `loadConfig` stays synchronous and never touches the keychain: only user mode, `login` and a daemon without a
 * computer credential (older setups) resolve the personal key.
 */
import { resolve } from 'node:path';
import { configPath, readStoredConfig, writeStoredConfig, type ResolvedConfig } from '../config.js';
import { registerSecret } from '../util/redact.js';
import { LibSecret } from './libsecret.js';
import { MacKeychain } from './macos.js';
import { SecretStoreError, type SecretStore, type SecretStoreKind } from './store.js';

export { SecretStoreError, type SecretStore, type SecretStoreKind } from './store.js';

export type PersonalKeyStorage = SecretStoreKind | 'file' | 'env';

export interface PersonalKey {
  readonly key: string;
  readonly storage: PersonalKeyStorage;
}

/** The keychain for this platform; null when there is none or `NOCOPROJECT_KEYCHAIN=off`. */
export function defaultSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore | null {
  if (/^(off|0|false|no)$/i.test(env.NOCOPROJECT_KEYCHAIN ?? '')) return null;
  if (process.platform === 'darwin') return new MacKeychain();
  if (process.platform === 'linux') return new LibSecret(undefined, undefined, env);
  return null;
}

/** One entry per `NOCOPROJECT_HOME`, so test homes and temporary daemons never overwrite the real one. */
export function personalKeyAccount(home: string): string {
  return resolve(home);
}

function entryLabel(serverUrl: string | undefined): string {
  return `NocoProject personal API key${serverUrl ? ` (${serverUrl})` : ''}`;
}

export function describeStorage(storage: PersonalKeyStorage, home: string): string {
  if (storage === 'keychain') return 'the macOS Keychain';
  if (storage === 'libsecret') return 'the system keyring (libsecret)';
  if (storage === 'env') return 'NOCOPROJECT_API_KEY';
  return `plain text in ${configPath(home)} (0600)`;
}

export interface ResolveOptions {
  readonly home: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly store: SecretStore | null;
  /** Move a plain-text key into the keychain (login and user mode; not the daemon). */
  readonly migrate?: boolean;
  readonly notify?: (line: string) => void;
}

/** The personal key and where it came from, or undefined when there is none. Throws when the keychain is unreadable. */
export async function resolvePersonalKey(opts: ResolveOptions): Promise<PersonalKey | undefined> {
  const envKey = opts.env?.NOCOPROJECT_API_KEY;
  if (envKey) {
    registerSecret(envKey);
    return { key: envKey, storage: 'env' };
  }
  const stored = readStoredConfig(opts.home);
  if (stored.apiKeyStorage) {
    const where = describeStorage(stored.apiKeyStorage, opts.home);
    if (!opts.store || opts.store.kind !== stored.apiKeyStorage) {
      throw new SecretStoreError(`the personal API key is saved in ${where}, which this process cannot use (NOCOPROJECT_KEYCHAIN=off?); set NOCOPROJECT_API_KEY or log in again`);
    }
    let key: string | undefined;
    try {
      key = await opts.store.get(personalKeyAccount(opts.home));
    } catch (error) {
      const hint = stored.apiKeyStorage === 'keychain' ? '`security unlock-keychain`, or ' : '';
      throw new SecretStoreError(`${(error as Error).message}; unlock it (${hint}log in to the desktop session) or set NOCOPROJECT_API_KEY`);
    }
    if (!key) return undefined;
    registerSecret(key);
    return { key, storage: stored.apiKeyStorage };
  }
  if (!stored.apiKey) return undefined;
  registerSecret(stored.apiKey);
  if (opts.migrate && opts.store && (await opts.store.available())) {
    try {
      await opts.store.set(personalKeyAccount(opts.home), stored.apiKey, entryLabel(stored.serverUrl));
      writeStoredConfig({ ...readStoredConfig(opts.home), apiKey: undefined, apiKeyStorage: opts.store.kind }, opts.home);
      opts.notify?.(`Moved the personal API key from ${configPath(opts.home)} into ${describeStorage(opts.store.kind, opts.home)}.`);
      return { key: stored.apiKey, storage: opts.store.kind };
    } catch {
      // Keep the plain key; the next run tries again.
    }
  }
  return { key: stored.apiKey, storage: 'file' };
}

export interface SavedPersonalKey {
  readonly storage: SecretStoreKind | 'file';
  /** Set when the key had to go into `config.json` in plain text. */
  readonly warning?: string;
}

/** Saves the personal key (keychain first, plain text otherwise) without touching the computer credential. */
export async function savePersonalKey(home: string, key: string, store: SecretStore | null): Promise<SavedPersonalKey> {
  const stored = readStoredConfig(home);
  let reason = 'no system keychain here';
  if (store && (await store.available())) {
    try {
      await store.set(personalKeyAccount(home), key, entryLabel(stored.serverUrl));
      writeStoredConfig({ ...readStoredConfig(home), apiKey: undefined, apiKeyStorage: store.kind }, home);
      return { storage: store.kind };
    } catch (error) {
      reason = (error as Error).message;
    }
  }
  writeStoredConfig({ ...readStoredConfig(home), apiKey: key, apiKeyStorage: undefined }, home);
  if (stored.apiKeyStorage && store) await store.delete(personalKeyAccount(home)).catch(() => undefined);
  return {
    storage: 'file',
    warning: `Warning: ${reason}; the personal API key is saved in plain text in ${configPath(home)} (0600). Agents dispatched to this computer run as the same user and can read it.`,
  };
}

/**
 * The daemon's config with the personal key filled in from the keychain, for an older setup without a computer
 * credential. With a computer credential (or a plain / env key) the keychain is not touched.
 */
export async function withPersonalKey<T extends ResolvedConfig>(cfg: T, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (cfg.computerKey || cfg.apiKey || !readStoredConfig(cfg.home).apiKeyStorage) return cfg;
  const personal = await resolvePersonalKey({ home: cfg.home, env, store: defaultSecretStore(env) });
  return personal ? { ...cfg, apiKey: personal.key } : cfg;
}
