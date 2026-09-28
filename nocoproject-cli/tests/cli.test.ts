import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  token = mock.issueToken('i9');
});
afterAll(async () => mock.stop());

/** Async spawn: the mock server lives in this process, so a sync spawn would deadlock. */
function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const home = mkdtempSync(join(tmpdir(), 'ncp-cli-'));
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, NOCOPROJECT_HOME: home, NOCOPROJECT_SERVER_URL: mock.url, NOCOPROJECT_TOKEN: token, ...env },
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
    expect(JSON.parse(r.out)).toMatchObject({ version: '0.3.0', protocolVersion: 1 });
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
});
