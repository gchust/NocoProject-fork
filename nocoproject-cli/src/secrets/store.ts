/**
 * The system keychain behind one small interface (NP-190): macOS Keychain through `/usr/bin/security`, Linux libsecret
 * through `secret-tool`. The CLI stores the person's API key there instead of in `config.json`. No native module: the
 * CLI is one bundled file installed with `npm i -g <tgz>`. Secrets always travel on stdin, never in process arguments.
 */
import { spawn } from 'node:child_process';

export type SecretStoreKind = 'keychain' | 'libsecret';

export interface SecretStore {
  readonly kind: SecretStoreKind;
  /** False when there is no usable keychain here (no tool, no session bus, no default keychain). */
  available(): Promise<boolean>;
  /** The stored secret, or undefined when there is no entry. Throws when the keychain cannot be read (locked, …). */
  get(account: string): Promise<string | undefined>;
  /** Stores (or replaces) the secret and reads it back; throws when it did not stick. */
  set(account: string, secret: string, label: string): Promise<void>;
  /** Removes the entry; no entry is not an error. */
  delete(account: string): Promise<void>;
}

/** The keychain service name of every NocoProject entry; the account is the `NOCOPROJECT_HOME` path. */
export const SECRET_SERVICE = 'nocoproject-cli';

export interface ToolResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunTool = (command: string, args: readonly string[], input?: string) => Promise<ToolResult>;

/** Runs a keychain tool with a timeout (a locked keychain can wait on an unlock dialog). */
export const runTool: RunTool = (command, args, input) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}
