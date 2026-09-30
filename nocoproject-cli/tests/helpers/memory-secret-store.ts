import type { SecretStore, SecretStoreKind } from '../../src/secrets/index.js';

/** An in-memory keychain for tests (NP-190); `failWrites` / `failReads` simulate a keychain that refuses. */
export class MemorySecretStore implements SecretStore {
  readonly entries = new Map<string, string>();
  failWrites = false;
  failReads = false;

  constructor(
    readonly kind: SecretStoreKind = 'keychain',
    private readonly isAvailable = true,
  ) {}

  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async get(account: string): Promise<string | undefined> {
    if (this.failReads) throw new Error('keychain is locked');
    return this.entries.get(account);
  }
  async set(account: string, secret: string): Promise<void> {
    if (this.failWrites) throw new Error('write refused');
    this.entries.set(account, secret);
  }
  async delete(account: string): Promise<void> {
    this.entries.delete(account);
  }
}
