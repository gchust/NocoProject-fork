import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialStatus } from '../src/cli/login.js';
import { personalKeyMissing } from '../src/cli/user-context.js';
import { configPath, loadConfig, readStoredConfig, writeStoredConfig } from '../src/config.js';
import { ensureKeychainGuards, keychainGuardScript } from '../src/daemon/env.js';
import { defaultSecretStore, personalKeyAccount, resolvePersonalKey, savePersonalKey, withPersonalKey } from '../src/secrets/index.js';
import { LibSecret } from '../src/secrets/libsecret.js';
import { MacKeychain } from '../src/secrets/macos.js';
import type { RunTool } from '../src/secrets/store.js';
import { MemorySecretStore } from './helpers/memory-secret-store.js';

const KEY = 'npk_personal-0123456789';
const home = () => mkdtempSync(join(tmpdir(), 'ncp-secrets-'));

describe('saving the personal key (NP-190)', () => {
  it('puts it into the keychain and leaves the computer credential alone', async () => {
    const h = home();
    writeStoredConfig({ serverUrl: 'http://x/main', computerKey: 'npc_computer-0123456789', apiKey: 'old-plain-key-123' }, h);
    const store = new MemorySecretStore();
    expect(await savePersonalKey(h, KEY, store)).toEqual({ storage: 'keychain' });
    expect(store.entries.get(personalKeyAccount(h))).toBe(KEY);
    const saved = readStoredConfig(h);
    expect(saved).toMatchObject({ computerKey: 'npc_computer-0123456789', apiKeyStorage: 'keychain' });
    expect(saved.apiKey).toBeUndefined();
    expect(readFileSync(configPath(h), 'utf8')).not.toContain(KEY);
  });

  it('falls back to plain text (0600) with a warning when there is no keychain', async () => {
    for (const store of [null, new MemorySecretStore('libsecret', false)]) {
      const h = home();
      writeStoredConfig({ computerKey: 'npc_computer-0123456789' }, h);
      const saved = await savePersonalKey(h, KEY, store);
      expect(saved.storage).toBe('file');
      expect(saved.warning).toContain(`plain text in ${configPath(h)} (0600)`);
      expect(saved.warning).toContain('Agents dispatched to this computer run as the same user and can read it');
      expect(readStoredConfig(h)).toMatchObject({ apiKey: KEY, computerKey: 'npc_computer-0123456789' });
      expect(statSync(configPath(h)).mode & 0o777).toBe(0o600);
    }
  });

  it('falls back when the keychain refuses the write, and says why', async () => {
    const h = home();
    const store = new MemorySecretStore();
    store.failWrites = true;
    const saved = await savePersonalKey(h, KEY, store);
    expect(saved.storage).toBe('file');
    expect(saved.warning).toContain('write refused');
    expect(readStoredConfig(h).apiKey).toBe(KEY);
  });
});

describe('resolving the personal key', () => {
  it('prefers NOCOPROJECT_API_KEY', async () => {
    const h = home();
    const store = new MemorySecretStore();
    await savePersonalKey(h, KEY, store);
    expect(await resolvePersonalKey({ home: h, env: { NOCOPROJECT_API_KEY: 'env-key-123456' }, store })).toEqual({ key: 'env-key-123456', storage: 'env' });
  });

  it('reads it from the keychain', async () => {
    const h = home();
    const store = new MemorySecretStore('libsecret');
    await savePersonalKey(h, KEY, store);
    expect(await resolvePersonalKey({ home: h, env: {}, store })).toEqual({ key: KEY, storage: 'libsecret' });
  });

  it('moves a plain-text key into the keychain and out of config.json', async () => {
    const h = home();
    writeStoredConfig({ serverUrl: 'http://x/main', apiKey: KEY, computerKey: 'npc_computer-0123456789' }, h);
    const store = new MemorySecretStore();
    const notes: string[] = [];
    expect(await resolvePersonalKey({ home: h, env: {}, store, migrate: true, notify: (l) => notes.push(l) })).toEqual({ key: KEY, storage: 'keychain' });
    expect(store.entries.get(personalKeyAccount(h))).toBe(KEY);
    expect(readStoredConfig(h)).toEqual({ serverUrl: 'http://x/main', computerKey: 'npc_computer-0123456789', apiKeyStorage: 'keychain' });
    expect(notes[0]).toContain('Moved the personal API key');
  });

  it('keeps the plain-text key when the move fails, or without migrate', async () => {
    const h = home();
    writeStoredConfig({ apiKey: KEY }, h);
    const store = new MemorySecretStore();
    expect(await resolvePersonalKey({ home: h, env: {}, store })).toEqual({ key: KEY, storage: 'file' });
    store.failWrites = true;
    expect(await resolvePersonalKey({ home: h, env: {}, store, migrate: true })).toEqual({ key: KEY, storage: 'file' });
    expect(readStoredConfig(h).apiKey).toBe(KEY);
    expect(store.entries.size).toBe(0);
  });

  it('explains an unreadable keychain instead of falling back', async () => {
    const h = home();
    const store = new MemorySecretStore();
    await savePersonalKey(h, KEY, store);
    store.failReads = true;
    await expect(resolvePersonalKey({ home: h, env: {}, store })).rejects.toThrow(/keychain is locked.*security unlock-keychain.*NOCOPROJECT_API_KEY/);
    await expect(resolvePersonalKey({ home: h, env: {}, store: null })).rejects.toThrow(/NOCOPROJECT_KEYCHAIN=off/);
  });

  it('gives the daemon the keychain key only when it has no computer credential', async () => {
    const h = home();
    await savePersonalKey(h, KEY, new MemorySecretStore());
    // The real keychain is not reachable with NOCOPROJECT_KEYCHAIN=off: the call must not even try without need.
    const env = { NOCOPROJECT_HOME: h, NOCOPROJECT_KEYCHAIN: 'off', NOCOPROJECT_COMPUTER_KEY: 'npc_computer-0123456789' };
    const cfg = loadConfig(env);
    expect(await withPersonalKey(cfg, env)).toBe(cfg);
    const legacy = loadConfig({ NOCOPROJECT_HOME: h, NOCOPROJECT_KEYCHAIN: 'off' });
    await expect(withPersonalKey(legacy, { NOCOPROJECT_KEYCHAIN: 'off' })).rejects.toThrow(/cannot use/);
  });

  it('NOCOPROJECT_KEYCHAIN=off disables the keychain', () => {
    expect(defaultSecretStore({ NOCOPROJECT_KEYCHAIN: 'off' })).toBeNull();
  });
});

describe('keychain tools', () => {
  function recorder(results: { code: number; stdout?: string; stderr?: string }[]): { run: RunTool; calls: { command: string; args: readonly string[]; input?: string }[] } {
    const calls: { command: string; args: readonly string[]; input?: string }[] = [];
    const run: RunTool = async (command, args, input) => {
      calls.push({ command, args, input });
      const r = results.shift() ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    return { run, calls };
  }

  it('macOS: writes through `security -i` on stdin, never in the arguments, and reads it back', async () => {
    const { run, calls } = recorder([{ code: 0 }, { code: 0, stdout: `${KEY}\n` }]);
    await new MacKeychain(run).set('/home/a b', KEY, 'NocoProject personal API key (http://x/main)');
    expect(calls[0]?.args).toEqual(['-i']);
    expect(calls[0]?.input).toBe(`add-generic-password -U -s "nocoproject-cli" -a "/home/a b" -l "NocoProject personal API key (http://x/main)" -w "${KEY}"\n`);
    expect(calls.flatMap((c) => c.args).join(' ')).not.toContain(KEY);
    expect(calls[1]?.args).toEqual(['find-generic-password', '-s', 'nocoproject-cli', '-a', '/home/a b', '-w']);
  });

  it('macOS: no entry is undefined, other failures throw, a write that did not stick throws', async () => {
    expect(await new MacKeychain(recorder([{ code: 44 }]).run).get('a')).toBeUndefined();
    await expect(new MacKeychain(recorder([{ code: 51, stderr: 'User interaction is not allowed.' }]).run).get('a')).rejects.toThrow(/User interaction/);
    await expect(new MacKeychain(recorder([{ code: 0 }, { code: 44 }]).run).set('a', KEY, 'l')).rejects.toThrow(/did not stick/);
    await expect(new MacKeychain(recorder([]).run).set('a', 'bad"key', 'l')).rejects.toThrow();
  });

  it('libsecret: the secret goes on stdin; an unavailable service is detected', async () => {
    const { run, calls } = recorder([{ code: 0 }, { code: 0, stdout: KEY }]);
    await new LibSecret(run, '/usr/bin/secret-tool').set('/h', KEY, 'label');
    expect(calls[0]).toEqual({ command: '/usr/bin/secret-tool', args: ['store', '--label=label', 'service', 'nocoproject-cli', 'account', '/h'], input: KEY });
    expect(await new LibSecret(recorder([{ code: 1 }]).run, '/x').get('/h')).toBeUndefined();
    await expect(new LibSecret(recorder([{ code: 1, stderr: 'Cannot autolaunch D-Bus' }]).run, '/x').get('/h')).rejects.toThrow(/D-Bus/);
    expect(await new LibSecret(recorder([]).run, null, { DBUS_SESSION_BUS_ADDRESS: 'x' }).available()).toBe(false);
  });
});

describe('agent run guards', () => {
  const guard = () => {
    const dir = home();
    const real = join(dir, 'real-tool');
    writeFileSync(real, '#!/bin/sh\necho "real $*"\n');
    chmodSync(real, 0o755);
    const path = join(dir, 'security');
    writeFileSync(path, keychainGuardScript(real));
    chmodSync(path, 0o755);
    return path;
  };
  const run = (path: string, args: string[], env: Record<string, string>) => spawnSync('/bin/sh', [path, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });

  it('refuses the reading subcommands inside a run', () => {
    const path = guard();
    for (const args of [['find-generic-password', '-s', 'nocoproject-cli', '-w'], ['-q', 'dump-keychain'], ['-i'], ['lookup', 'service', 'nocoproject-cli'], ['search', '--all']]) {
      const r = run(path, args, { NOCOPROJECT_TOKEN: 'npr_x' });
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toContain('agent runs cannot read the keychain');
      expect(r.stdout).toBe('');
    }
  });

  it('passes other subcommands through, and everything outside a run', () => {
    const path = guard();
    expect(run(path, ['list-keychains'], { NOCOPROJECT_RUN_ID: 'r1' }).stdout).toBe('real list-keychains\n');
    expect(run(path, ['find-generic-password', '-w'], {}).stdout).toBe('real find-generic-password -w\n');
  });

  it('writes a guard for each keychain tool found on PATH', () => {
    const bin = home();
    const tools = home();
    const real = join(tools, 'secret-tool');
    writeFileSync(real, '#!/bin/sh\n');
    chmodSync(real, 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${tools}`;
    try {
      ensureKeychainGuards(bin);
    } finally {
      process.env.PATH = before;
    }
    expect(readFileSync(join(bin, 'secret-tool'), 'utf8')).toContain(`exec ${JSON.stringify(real)} "$@"`);
    expect(spawnSync('/bin/sh', [join(bin, 'secret-tool'), 'lookup'], { env: { NOCOPROJECT_TOKEN: 'x' } }).status).toBe(1);
  });
});

describe('messages', () => {
  it('login ends with both credentials and where the personal key is', () => {
    const h = home();
    expect(credentialStatus('http://x/main', h, true, 'keychain')).toEqual([
      'Computer credential: saved (the daemon uses it)',
      'Personal API key:    saved in the macOS Keychain (for `nocoproject user …`)',
    ]);
    const none = credentialStatus('http://x/main', h, false, null);
    expect(none[0]).toContain('nocoproject login --server http://x/main --computer-key-stdin');
    expect(none[1]).toContain('nocoproject login --server http://x/main --api-key-stdin');
  });

  it('user mode says the personal key is not the computer credential and how to log in', () => {
    const text = personalKeyMissing('https://p.example/main');
    expect(text).toContain("separate from this computer's credential");
    expect(text).toContain('nocoproject login --server https://p.example/main --api-key-stdin');
    expect(personalKeyMissing(undefined)).toContain('--server <url>');
  });
});
