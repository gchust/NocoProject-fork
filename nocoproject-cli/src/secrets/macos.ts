/** macOS Keychain through `/usr/bin/security` (NP-190). */
import { existsSync } from 'node:fs';
import { runTool, SECRET_SERVICE, SecretStoreError, type RunTool, type SecretStore } from './store.js';

const SECURITY = '/usr/bin/security';
/** `errSecItemNotFound`: the exit code of `find-` / `delete-generic-password` when there is no entry. */
const NOT_FOUND = 44;

/** `security -i` parses double-quoted words; refuse anything that would need escaping (API keys never do). */
function quote(value: string): string {
  if (/["\\\n\r]/.test(value)) throw new SecretStoreError('value contains characters the keychain command cannot take');
  return `"${value}"`;
}

export class MacKeychain implements SecretStore {
  readonly kind = 'keychain' as const;

  constructor(private readonly run: RunTool = runTool) {}

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin' || !existsSync(SECURITY)) return false;
    return (await this.run(SECURITY, ['default-keychain'])).code === 0;
  }

  async get(account: string): Promise<string | undefined> {
    const r = await this.run(SECURITY, ['find-generic-password', '-s', SECRET_SERVICE, '-a', account, '-w']);
    if (r.code === NOT_FOUND) return undefined;
    if (r.code !== 0) throw new SecretStoreError(`cannot read the macOS Keychain: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout.replace(/\r?\n$/, '') || undefined;
  }

  async set(account: string, secret: string, label: string): Promise<void> {
    // `security -i` reads the command from stdin, so the key never shows up in `ps`. It exits 0 even when the
    // command fails, hence the read-back.
    const line = `add-generic-password -U -s ${quote(SECRET_SERVICE)} -a ${quote(account)} -l ${quote(label)} -w ${quote(secret)}\n`;
    const r = await this.run(SECURITY, ['-i'], line);
    if (r.code !== 0 || (await this.get(account)) !== secret) throw new SecretStoreError(`cannot write to the macOS Keychain: ${r.stderr.trim() || 'the entry did not stick'}`);
  }

  async delete(account: string): Promise<void> {
    const r = await this.run(SECURITY, ['delete-generic-password', '-s', SECRET_SERVICE, '-a', account]);
    if (r.code !== 0 && r.code !== NOT_FOUND) throw new SecretStoreError(`cannot delete from the macOS Keychain: ${r.stderr.trim()}`);
  }
}
