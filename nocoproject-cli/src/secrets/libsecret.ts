/** Linux libsecret (GNOME Keyring, KWallet's Secret Service) through `secret-tool` (NP-190). */
import { which } from '../util/process.js';
import { runTool, SECRET_SERVICE, SecretStoreError, type RunTool, type SecretStore } from './store.js';

export class LibSecret implements SecretStore {
  readonly kind = 'libsecret' as const;
  private readonly tool: string | null;

  constructor(
    private readonly run: RunTool = runTool,
    tool: string | null = which('secret-tool'),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.tool = tool;
  }

  private attrs(account: string): string[] {
    return ['service', SECRET_SERVICE, 'account', account];
  }

  async available(): Promise<boolean> {
    if (process.platform !== 'linux' || !this.tool || !this.env.DBUS_SESSION_BUS_ADDRESS) return false;
    // `lookup` exits 1 with an empty stderr when there is simply no entry; a missing service or bus writes an error.
    const r = await this.run(this.tool, ['lookup', ...this.attrs('nocoproject-probe')]);
    return r.code === 0 || (r.code === 1 && r.stderr.trim() === '');
  }

  async get(account: string): Promise<string | undefined> {
    const r = await this.run(this.requireTool(), ['lookup', ...this.attrs(account)]);
    if (r.code === 1 && r.stderr.trim() === '') return undefined;
    if (r.code !== 0) throw new SecretStoreError(`cannot read the system keyring: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout.replace(/\r?\n$/, '') || undefined;
  }

  async set(account: string, secret: string, label: string): Promise<void> {
    const r = await this.run(this.requireTool(), ['store', `--label=${label}`, ...this.attrs(account)], secret);
    if (r.code !== 0 || (await this.get(account)) !== secret) throw new SecretStoreError(`cannot write to the system keyring: ${r.stderr.trim() || 'the entry did not stick'}`);
  }

  async delete(account: string): Promise<void> {
    const r = await this.run(this.requireTool(), ['clear', ...this.attrs(account)]);
    if (r.code !== 0 && r.stderr.trim() !== '') throw new SecretStoreError(`cannot delete from the system keyring: ${r.stderr.trim()}`);
  }

  private requireTool(): string {
    if (!this.tool) throw new SecretStoreError('secret-tool is not installed');
    return this.tool;
  }
}
