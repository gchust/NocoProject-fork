import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockServer } from './helpers/mock-server.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
let mock: MockServer;
let token: string;

beforeAll(async () => {
  mock = new MockServer();
  await mock.start();
  mock.runtimes.set('echo', { id: 'rt-echo', provider: 'echo' });
  mock.addIssue({ id: 'i9', identifier: 'NP-9', title: 'CLI issue', description: 'Body **md**' });
  mock.addIssue({ id: 'i10', identifier: 'NP-10', title: 'Other issue' });
  mock.addIssue({ id: 'i11', identifier: 'NP-11', title: 'Gated issue', statusKey: 'in_progress', approvalRequired: ['in_review'] });
  mock.addIssue({
    id: 'i12',
    identifier: 'NP-12',
    title: 'With files',
    attachments: [
      { id: 'f1', filename: 'shot.png', mimeType: 'image/png', size: 4 },
      { id: 'f2', filename: '../shot.png', mimeType: 'image/png', size: 2 },
      { id: 'f3', filename: 'SHOT.png', mimeType: 'image/png', size: 2 },
    ],
  });
  mock.attachmentBytes.set('f1', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  mock.attachmentBytes.set('f2', new Uint8Array([1, 2]));
  mock.attachmentBytes.set('f3', new Uint8Array([3, 4]));
  token = mock.issueToken('i9');
});
afterAll(async () => mock.stop());

/** Async spawn: the mock server lives in this process, so a sync spawn would deadlock. */
function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const home = mkdtempSync(join(tmpdir(), 'ncp-cli-'));
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: home,
    // NOCOPROJECT_KEYCHAIN=off: never touch the real keychain of the machine running the tests (NP-190).
    env: { PATH: process.env.PATH, HOME: home, NOCOPROJECT_HOME: home, NOCOPROJECT_KEYCHAIN: 'off', NOCOPROJECT_SERVER_URL: mock.url, NOCOPROJECT_TOKEN: token, ...env },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

describe('run-token mode CLI', () => {
  it('gets the run issue by identifier (via /np/agent/context)', async () => {
    const r = await run(['issue', 'get', 'NP-9', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ id: 'i9', identifier: 'NP-9', description: 'Body **md**' });
    expect(mock.callsTo(/GET \/np\/agent\/context/).length).toBeGreaterThan(0);
  });

  it('uses NOCOPROJECT_ISSUE_ID/KEY without a context call and prints text', async () => {
    const before = mock.callsTo(/agent\/context/).length;
    const r = await run(['issue', 'get'], { NOCOPROJECT_ISSUE_ID: 'i9', NOCOPROJECT_ISSUE_KEY: 'NP-9' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('NP-9  CLI issue');
    expect(mock.callsTo(/agent\/context/).length).toBe(before);
  });

  it('accepts raw ids and reports 404 as exit 4', async () => {
    expect((await run(['issue', 'get', 'i10', '--json'])).code).toBe(0);
    const r = await run(['issue', 'get', 'nope', '--json']);
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out).error.code).toBe('ISSUE_NOT_FOUND');
  });

  it('adds comments from a file, with a parent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ncp-cli-'));
    writeFileSync(join(cwd, 'reply.md'), '# Report\nAll good.');
    const r = await run(['issue', 'comment', 'add', 'NP-9', '--content-file', join(cwd, 'reply.md'), '--parent', 'c1', '--json']);
    expect(r.code).toBe(0);
    const call = mock.callsTo(/POST \/np\/agent\/issues\/i9\/comments/).at(-1);
    expect(call?.body).toEqual({ content: '# Report\nAll good.', parentId: 'c1' });
  });

  it('validates comment input (exit 5)', async () => {
    expect((await run(['issue', 'comment', 'add', 'NP-9', '--json'])).code).toBe(5);
    expect((await run(['issue', 'comment', 'add', 'NP-9', '--content-file', '/nonexistent.md'])).code).toBe(5);
    expect((await run(['issue', 'comment', 'add', 'NP-9', '--content', 'a', '--content-file', 'b'])).code).toBe(5);
    expect((await run(['issue', 'comment', 'add', 'NP-9', '--content', '   '])).code).toBe(5);
  });

  it('lists comments', async () => {
    const r = await run(['issue', 'comment', 'list', 'NP-9', '--tail', '5', '--json']);
    expect(r.code).toBe(0);
    expect(Array.isArray(JSON.parse(r.out))).toBe(true);
    expect(mock.callsTo(/GET \/np\/agent\/issues\/i9\/comments\?tail=5/).length).toBe(1);
  });

  it('changes status and maps forbidden transitions to exit 5', async () => {
    expect((await run(['issue', 'status', 'in_progress', '--json'], { NOCOPROJECT_ISSUE_ID: 'i9' })).code).toBe(0);
    expect(mock.issues.get('i9')?.statusKey).toBe('in_progress');
    const r = await run(['issue', 'status', 'NP-9', 'done', '--json']);
    expect(r.code).toBe(5);
    expect(JSON.parse(r.out).error.code).toBe('TRANSITION_NOT_ALLOWED');
  });

  it('treats a 202 approval gate as success (text and --json)', async () => {
    const r = await run(['issue', 'status', 'NP-11', 'in_review']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^approval pending \(request ap\d+\)$/);
    expect(mock.issues.get('i11')?.statusKey).toBe('in_progress');
    const j = await run(['issue', 'status', 'NP-11', 'in_review', '--json']);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toMatchObject({ issue: { id: 'i11', statusKey: 'in_progress' }, pendingApproval: { status: 'pending', toStatus: 'in_review', fromStatus: 'in_progress' } });
  });

  it('lists and downloads attachments with safe, distinct names (NP-111)', async () => {
    const list = await run(['issue', 'attachment', 'list', 'NP-12']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('f1  shot.png  image/png  4 B');
    const text = await run(['issue', 'get', 'NP-12']);
    expect(text.out).toContain('attachments (3; save them with `nocoproject issue attachment download NP-12`)');
    const dir = mkdtempSync(join(tmpdir(), 'ncp-att-'));
    const r = await run(['issue', 'attachment', 'download', 'NP-12', '--dir', dir, '--json']);
    expect(r.code).toBe(0);
    const saved = JSON.parse(r.out) as { id: string; path: string }[];
    expect(saved.map((file) => file.path)).toEqual([join(dir, 'shot.png'), join(dir, '.._shot.png'), join(dir, 'f3-SHOT.png')]);
    expect([...readFileSync(join(dir, 'shot.png'))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(mock.callsTo(/GET \/np\/agent\/issues\/NP-12\/attachments\/f1\/content/).length).toBe(1);
    expect([...readFileSync(join(dir, 'f3-SHOT.png'))]).toEqual([3, 4]);
    const one = await run(['issue', 'attachment', 'download', 'NP-12', '--id', 'f2', '--dir', dir]);
    expect(one.out.trim()).toBe(`${join(dir, '.._shot.png')}  (image/png, 2 B)`);
    const missing = await run(['issue', 'attachment', 'download', 'NP-12', '--id', 'nope', '--json']);
    expect(missing.code).toBe(4);
    expect(JSON.parse(missing.out).error.code).toBe('ATTACHMENT_NOT_FOUND');
    const none = await run(['issue', 'attachment', 'download', 'NP-10', '--dir', dir]);
    expect(none.out.trim()).toBe('(no attachments)');
  });

  it('links and lists pull requests', async () => {
    const url = 'https://github.com/acme/demo/pull/7';
    const r = await run(['pr', 'link', url], { NOCOPROJECT_ISSUE_ID: 'i9', NOCOPROJECT_ISSUE_KEY: 'NP-9' });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('linked acme/demo#7 (open) to NP-9');
    expect(mock.callsTo(/POST \/np\/agent\/issues\/i9\/pull-requests/).at(-1)?.body).toEqual({ url });
    const other = await run(['pr', 'link', 'https://github.com/acme/demo/pull/8', '--issue', 'NP-10', '--json']);
    expect(other.code).toBe(0);
    expect(JSON.parse(other.out)).toMatchObject({ repo: 'acme/demo', number: 8, state: 'open', linkedBy: { type: 'agent' } });
    expect(mock.pullRequests.get('i10')).toHaveLength(1);
    const list = await run(['pr', 'list', '--json'], { NOCOPROJECT_ISSUE_ID: 'i9' });
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out).map((p: { number: number }) => p.number)).toEqual([7]);
    const text = await run(['pr', 'list', '--issue', 'i10']);
    expect(text.out).toContain('acme/demo#8 (open)\n  https://github.com/acme/demo/pull/8');
  });

  it('rejects bad pull request URLs (exit 5)', async () => {
    const local = await run(['pr', 'link', 'not a url', '--json'], { NOCOPROJECT_ISSUE_ID: 'i9' });
    expect(local.code).toBe(5);
    expect(JSON.parse(local.out).error.code).toBe('INVALID_PR_URL');
    const remote = await run(['pr', 'link', 'https://github.com/acme/demo/issues/3', '--json'], { NOCOPROJECT_ISSUE_ID: 'i9' });
    expect(remote.code).toBe(5);
    expect(JSON.parse(remote.out).error.code).toBe('INVALID_PR_URL');
  });

  it('maps auth and network failures to exit 3 and 2', async () => {
    expect((await run(['issue', 'get', 'i9'], { NOCOPROJECT_TOKEN: `npr_${'0'.repeat(40)}` })).code).toBe(3);
    expect((await run(['issue', 'get', 'i9'], { NOCOPROJECT_TOKEN: undefined })).code).toBe(3);
    const r = await run(['issue', 'get', 'i9', '--json'], { NOCOPROJECT_SERVER_URL: 'http://127.0.0.1:9/main' });
    expect(r.code).toBe(2);
    expect(r.out).not.toContain(token);
  });

  it('prints the version', async () => {
    const r = await run(['version', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ version: '0.6.1', protocolVersion: 2 });
  });

  it('logs in against the server and stores the key with 0600', async () => {
    const { API_KEY } = await import('./helpers/mock-server.js');
    const origin = mock.url.replace(/\/main$/, '');
    const r = await run(['login', '--server', origin, '--api-key', API_KEY, '--json'], { NOCOPROJECT_SERVER_URL: undefined, NOCOPROJECT_TOKEN: undefined });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ serverUrl: mock.url, user: 'Alice', verified: true });
    expect(r.out).not.toContain(API_KEY);
    const bad = await run(['login', '--server', mock.url, '--api-key', 'wrong-key-123456', '--json'], { NOCOPROJECT_SERVER_URL: undefined });
    expect(bad.code).toBe(3);
  });

  it('keeps both credentials: logging in with one never removes the other (NP-190)', async () => {
    const { API_KEY, COMPUTER_KEY } = await import('./helpers/mock-server.js');
    const env = { NOCOPROJECT_SERVER_URL: undefined, NOCOPROJECT_TOKEN: undefined, NOCOPROJECT_HOME: mkdtempSync(join(tmpdir(), 'ncp-login-')) };
    const saved = () => JSON.parse(readFileSync(join(env.NOCOPROJECT_HOME, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect((await run(['login', '--server', mock.url, '--api-key', API_KEY, '--json'], env)).code).toBe(0);
    const r = await run(['login', '--server', mock.url, '--computer-key', COMPUTER_KEY, '--json'], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ credential: 'computer', verified: true, removedApiKey: false, computerCredential: true, personalKey: { storage: 'file' } });
    expect(r.out).not.toContain(COMPUTER_KEY);
    expect(saved()).toMatchObject({ computerKey: COMPUTER_KEY, apiKey: API_KEY });
    // And the other way round, in text mode: the status lines and the plain-text warning.
    const text = await run(['login', '--server', mock.url, '--api-key', API_KEY], env);
    expect(text.code).toBe(0);
    expect(saved()).toMatchObject({ computerKey: COMPUTER_KEY, apiKey: API_KEY });
    expect(text.out).toContain('Computer credential: saved (the daemon uses it)');
    expect(text.out).toContain(`Personal API key:    saved in plain text in ${join(env.NOCOPROJECT_HOME, 'config.json')} (0600)`);
    expect(text.err).toContain('Agents dispatched to this computer run as the same user and can read it');
    expect(text.out + text.err).not.toContain(API_KEY);
    const bad = await run(['login', '--server', mock.url, '--computer-key', 'npc_wrong-0123456789', '--json'], { NOCOPROJECT_SERVER_URL: undefined });
    expect(bad.code).toBe(3);
  });

  it('shows a missing credential with the command that adds it, and --keep-api-key as deprecated', async () => {
    const { COMPUTER_KEY } = await import('./helpers/mock-server.js');
    const r = await run(['login', '--server', mock.url, '--computer-key', COMPUTER_KEY], { NOCOPROJECT_SERVER_URL: undefined, NOCOPROJECT_TOKEN: undefined });
    expect(r.out).toContain(`Personal API key:    none — for \`nocoproject user …\`: \`nocoproject login --server ${mock.url} --api-key-stdin\``);
    const help = await run(['login', '--help']);
    expect(help.out.replace(/\s+/g, ' ')).toContain('--keep-api-key deprecated, no effect: both credentials are kept');
  });
});
