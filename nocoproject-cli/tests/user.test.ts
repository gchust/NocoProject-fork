/**
 * CLI user mode (NP-86): `nocoproject user …` against a small browser-API mock. Covers the in-run refusal, the
 * headers (x-api-key + x-np-client, never Authorization), flag → query / body mapping with name resolution, the
 * status revision round-trip, JSON output, key redaction and `skill install`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserApi } from '../src/api/user-client.js';
import { NameResolver, pickByName } from '../src/cli/user-context.js';
import { userCreateBody, userIssuesQuery } from '../src/cli/user.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const KEY = 'npk_user_mode_secret_0123456789';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

let server: Server;
let url: string;
let home: string;
const seen: Seen[] = [];
/** Per-test overrides: `METHOD path` → [status, body]. */
let overrides: Map<string, (() => [number, unknown])[]>;

const ISSUE = { id: 'i1', identifier: 'NP-1', title: 'First', statusKey: 'todo', priority: 'none', ownerName: 'Ada', executorName: null, projectName: 'Core', labels: [], revision: 4, description: 'Do it' };
const COMMENT = (id: string) => ({ id, authorName: 'Ada', authorType: 'user', content: `c${id}`, parentId: null, rootId: id, createdAt: '2026-01-01T00:00:00Z' });

function defaults(method: string, path: string, query: Record<string, string>): [number, unknown] {
  const route = `${method} ${path}`;
  if (route === 'GET /api/np/me') return [200, { data: { userId: 'u1', name: 'Ada' } }];
  if (route === 'GET /api/np/projects') return [200, { data: [{ id: 'p1', name: 'Core', status: 'active' }, { id: 'p2', name: 'Twin' }, { id: 'p3', name: 'twin' }] }];
  if (route === 'GET /api/np/labels') return [200, { data: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'cli' }] }];
  if (route === 'GET /api/np/agents') return [200, { data: [{ id: 'a1', name: 'Claude Coder', runtimeOnline: true }] }];
  if (route === 'GET /api/np/issues') return [200, { data: [ISSUE], nextCursor: 'next-1' }];
  if (route === 'POST /api/np/issues') return [201, { data: { ...ISSUE, id: 'i2', identifier: 'NP-2', title: 'New' } }];
  if (route === 'GET /api/np/issues/NP-1') return [200, { data: { issue: ISSUE, comments: [COMMENT('3'), COMMENT('4')], commentsNextCursor: 'older' } }];
  if (route === 'GET /api/np/issues/i1/comments') return [200, { data: [COMMENT('1'), COMMENT('2')], nextCursor: null }];
  if (route === 'POST /api/np/issues/NP-1/comments') return [201, { data: { comment: COMMENT('9'), triggered: [] } }];
  if (route === 'PATCH /api/np/issues/i1') return [200, { data: { ...ISSUE, statusKey: 'in_progress', revision: 5 } }];
  if (route === 'GET /api/np/inbox') return [200, { data: [{ id: 'n1', kind: 'decision', type: 'design_review', issueIdentifier: 'NP-1', title: 'Review', readAt: null }], unread: 1, nextCursor: null, query }];
  return [404, { code: 'NOT_FOUND', message: `no route ${route}` }];
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const query = Object.fromEntries(parsed.searchParams);
      seen.push({ method: req.method ?? '', path: parsed.pathname, query, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const queue = overrides.get(`${req.method} ${parsed.pathname}`);
      const [status, body] = queue?.length ? (queue.shift() as () => [number, unknown])() : defaults(req.method ?? '', parsed.pathname, query);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = mkdtempSync(join(tmpdir(), 'ncp-user-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ serverUrl: url, apiKey: KEY, daemonId: 'd1' }), { mode: 0o600 });
});
afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
  overrides = new Map();
});

function override(route: string, ...responses: [number, unknown][]): void {
  overrides.set(
    route,
    responses.map((r) => () => r),
  );
}

function run(args: string[], env: Record<string, string> = {}, userHome = home): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: userHome, NOCOPROJECT_HOME: home, NOCOPROJECT_KEYCHAIN: 'off', ...env } });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

const SUBCOMMANDS: string[][] = [
  ['whoami'],
  ['issues'],
  ['issue', 'NP-1'],
  ['inbox'],
  ['create', '--title', 'x'],
  ['comment', 'NP-1', '--content', 'hi'],
  ['status', 'NP-1', 'done'],
  ['projects'],
  ['labels'],
  ['agents'],
  ['skill', 'install'],
];

describe('inside an agent run', () => {
  it.each([['NOCOPROJECT_TOKEN', 'npr_0123456789abcdef0123'], ['NOCOPROJECT_RUN_ID', 'run-1']])('refuses every user command when %s is set', async (name, value) => {
    const skillHome = mkdtempSync(join(tmpdir(), 'ncp-user-run-'));
    for (const args of SUBCOMMANDS) {
      const r = await run(['user', ...args, '--json'], { [name]: value }, skillHome);
      expect(r.code, args.join(' ')).toBe(3);
      expect(JSON.parse(r.out).error).toMatchObject({ code: 'USER_MODE_IN_RUN', exitCode: 3 });
    }
    expect(seen).toHaveLength(0);
    expect(existsSync(join(skillHome, '.claude'))).toBe(false);
  });
});

describe('requests', () => {
  it('sends the API key and the client name, never a bearer token, and never prints the key', async () => {
    const r = await run(['user', 'whoami', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ userId: 'u1', name: 'Ada', serverUrl: url, keyStorage: 'file' });
    const req = seen[0] as Seen;
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['x-np-client']).toBe('nocoproject-cli/0.7.0');
    expect(req.headers.authorization).toBeUndefined();
    expect(r.out + r.err).not.toContain(KEY);
  });

  it('redacts the key when the server echoes it in an error', async () => {
    override('GET /api/np/me', [401, { code: 'UNAUTHORIZED', message: `bad key ${KEY}` }]);
    const json = await run(['user', 'whoami', '--json']);
    expect(json.code).toBe(3);
    expect(json.out).not.toContain(KEY);
    expect(json.out).toContain('[REDACTED]');
    override('GET /api/np/me', [401, { code: 'UNAUTHORIZED', message: `bad key ${KEY}` }]);
    const text = await run(['user', 'whoami']);
    expect(text.err).not.toContain(KEY);
    expect(text.err).toContain('[REDACTED]');
  });

  it('asks to log in when no key is saved', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ncp-user-empty-'));
    const child = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [CLI, 'user', 'whoami', '--json'], { env: { PATH: process.env.PATH, HOME: empty, NOCOPROJECT_HOME: empty, NOCOPROJECT_KEYCHAIN: 'off' } });
      let out = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString()));
      p.on('close', (code) => resolve({ code, out }));
    });
    expect(child.code).toBe(3);
    expect(JSON.parse(child.out).error.code).toBe('NOT_LOGGED_IN');
    expect(JSON.parse(child.out).error.message).toContain("separate from this computer's credential");
  });

  it('whoami says where the key is stored (NP-190)', async () => {
    const text = await run(['user', 'whoami']);
    expect(text.out).toContain(`Ada (u1) on ${url} — key in plain text in ${join(home, 'config.json')} (0600)`);
    const env = await run(['user', 'whoami'], { NOCOPROJECT_API_KEY: KEY });
    expect(env.out).toContain('— key from NOCOPROJECT_API_KEY');
  });
});

describe('flag mapping', () => {
  const names = () => new NameResolver(new UserApi(url, KEY));

  it('defaults issues to the ones I own and maps filters with names resolved', async () => {
    expect(await userIssuesQuery({}, names())).toEqual({ ownerUserId: 'u1' });
    expect(await userIssuesQuery({ project: 'core', status: 'in_progress', label: 'bug', executor: 'Claude Coder', q: 'x', limit: 5, cursor: 'c' }, names())).toEqual({
      projectId: 'p1',
      statusKey: 'in_progress',
      labelId: 'l1',
      executorId: 'a1',
      q: 'x',
      limit: 5,
      cursor: 'c',
    });
    expect(await userIssuesQuery({ project: 'p1', mine: true }, names())).toEqual({ ownerUserId: 'u1', projectId: 'p1' });
  });

  it('never guesses a name', async () => {
    await expect(userIssuesQuery({ project: 'twin' }, names())).rejects.toMatchObject({ code: 'AMBIGUOUS_NAME', exitCode: 5 });
    await expect(userIssuesQuery({ project: 'nope' }, names())).rejects.toMatchObject({ code: 'NAME_NOT_FOUND', exitCode: 4 });
    expect(pickByName([{ id: 'p2', name: 'Twin' }, { id: 'p3', name: 'twin' }], 'p3', 'project').id).toBe('p3');
  });

  it('builds the create body without an owner unless one is given', async () => {
    const file = join(home, 'desc.md');
    writeFileSync(file, '# Why\n');
    expect(await userCreateBody({ title: ' New ', descriptionFile: file, project: 'Core', label: 'bug,cli', executor: 'claude coder', priority: 'high', parent: 'NP-1', blockedBy: 'NP-3,NP-4' }, names())).toEqual({
      title: 'New',
      description: '# Why\n',
      projectId: 'p1',
      labelIds: ['l1', 'l2'],
      executor: { type: 'agent', id: 'a1' },
      priority: 'high',
      parentIssueId: 'NP-1',
      blockedBy: ['NP-3', 'NP-4'],
    });
    expect(await userCreateBody({ title: 'x', executor: 'none', owner: 'me' }, names())).toEqual({ title: 'x', executor: { type: 'none' }, ownerUserId: 'u1' });
    await expect(userCreateBody({ title: 'x', priority: 'asap' }, names())).rejects.toMatchObject({ code: 'INVALID_PRIORITY' });
    expect(await userCreateBody({ title: 'x' }, names())).not.toHaveProperty('process');
  });

  it('passes --process through as given and refuses anything else locally', async () => {
    for (const process of ['direct', 'design_first', 'auto']) {
      expect(await userCreateBody({ title: 'x', process }, names())).toEqual({ title: 'x', process });
    }
    await expect(userCreateBody({ title: 'x', process: 'Direct' }, names())).rejects.toMatchObject({ code: 'INVALID_PROCESS', exitCode: 5 });
  });
});

describe('commands', () => {
  it('lists my issues with the owner filter and the next cursor', async () => {
    const r = await run(['user', 'issues', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ data: [{ identifier: 'NP-1' }], nextCursor: 'next-1' });
    expect(seen.find((s) => s.path === '/api/np/issues')?.query).toEqual({ ownerUserId: 'u1' });
    const text = await run(['user', 'issues', '--status', 'todo']);
    expect(text.out).toContain('NP-1  [todo]  First  (owner Ada, project Core)');
    expect(text.out).toContain('more: --cursor next-1');
  });

  it('shows an issue with the latest comments, or all of them', async () => {
    const last = JSON.parse((await run(['user', 'issue', 'np-1', '--comments', '1', '--json'])).out);
    expect(last.comments.map((c: { id: string }) => c.id)).toEqual(['4']);
    expect(last).toMatchObject({ commentsNextCursor: 'older', commentsOmitted: 1 });
    const all = JSON.parse((await run(['user', 'issue', 'NP-1', '--comments', 'all', '--json'])).out);
    expect(all.comments.map((c: { id: string }) => c.id)).toEqual(['1', '2', '3', '4']);
    expect(all.commentsNextCursor).toBeNull();
    expect((await run(['user', 'issue', 'NP-1'])).out).toContain('Do it');
  });

  it('creates an issue', async () => {
    const r = await run(['user', 'create', '--title', 'New', '--executor', 'Claude Coder', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ identifier: 'NP-2' });
    expect(seen.find((s) => s.method === 'POST')?.body).toEqual({ title: 'New', executor: { type: 'agent', id: 'a1' } });
  });

  it('creates an issue with a process, and refuses an unknown one before any request', async () => {
    expect((await run(['user', 'create', '--title', 'New', '--process', 'direct', '--json'])).code).toBe(0);
    expect(seen.find((s) => s.method === 'POST')?.body).toEqual({ title: 'New', process: 'direct' });
    seen.length = 0;
    const bad = await run(['user', 'create', '--title', 'New', '--process', 'quick']);
    expect(bad.code).toBe(5);
    expect(bad.err).toContain('--process must be one of auto, direct, design_first');
    expect(seen.some((s) => s.method === 'POST')).toBe(false);
  });

  it('comments from a file', async () => {
    const file = join(home, 'reply.md');
    writeFileSync(file, 'Looks good');
    const r = await run(['user', 'comment', 'NP-1', '--content-file', file, '--parent', 'c7']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('comment posted');
    expect(seen.find((s) => s.method === 'POST')?.body).toEqual({ content: 'Looks good', parentId: 'c7' });
    expect((await run(['user', 'comment', 'NP-1', '--content', '  ', '--json'])).code).toBe(5);
  });

  it('changes the status at the current revision and retries one conflict', async () => {
    override('PATCH /api/np/issues/i1', [409, { code: 'REVISION_CONFLICT', message: 'changed' }]);
    const r = await run(['user', 'status', 'NP-1', 'in_progress', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ statusKey: 'in_progress' });
    const patches = seen.filter((s) => s.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[0]?.body).toEqual({ statusKey: 'in_progress', revision: 4 });
  });

  it('reports an approval gate as pending with exit 0, and a refused transition as exit 5', async () => {
    override('PATCH /api/np/issues/i1', [202, { data: { issue: ISSUE, pendingApproval: { id: 'ap1' } } }]);
    const pending = await run(['user', 'status', 'NP-1', 'done']);
    expect(pending.code).toBe(0);
    expect(pending.out).toContain('approval pending (request ap1)');
    override('PATCH /api/np/issues/i1', [400, { code: 'TRANSITION_NOT_ALLOWED', message: 'no' }]);
    const refused = await run(['user', 'status', 'NP-1', 'done', '--json']);
    expect(refused.code).toBe(5);
    expect(JSON.parse(refused.out).error.code).toBe('TRANSITION_NOT_ALLOWED');
  });

  it('reads the unresolved inbox by default', async () => {
    const r = await run(['user', 'inbox', '--kind', 'decision']);
    expect(r.out).toContain('[decision/design_review] NP-1 Review  (unread)');
    expect(seen[0]?.query).toEqual({ kind: 'decision', resolved: 'false' });
    await run(['user', 'inbox', '--all']);
    expect(seen[1]?.query).toEqual({});
  });

  it('lists projects, labels and agents', async () => {
    expect((await run(['user', 'projects'])).out).toContain('Core  (p1, active)');
    expect(JSON.parse((await run(['user', 'labels', '--json'])).out)).toHaveLength(2);
    expect((await run(['user', 'agents'])).out).toContain('Claude Coder  (a1, online)');
  });
});

describe('skill install', () => {
  it('installs for both tools, leaves an identical copy alone and needs --force for a changed one', async () => {
    const userHome = mkdtempSync(join(tmpdir(), 'ncp-user-skill-'));
    const first = await run(['user', 'skill', 'install', '--json'], {}, userHome);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out).map((r: { tool: string; status: string }) => `${r.tool}:${r.status}`)).toEqual(['claude:installed', 'codex:installed']);
    const claude = join(userHome, '.claude', 'skills', 'nocoproject-user', 'SKILL.md');
    const content = readFileSync(claude, 'utf8');
    expect(content).toContain('name: nocoproject-user');
    expect(readFileSync(join(userHome, '.codex', 'skills', 'nocoproject-user', 'SKILL.md'), 'utf8')).toBe(content);

    expect(JSON.parse((await run(['user', 'skill', 'install', '--claude', '--json'], {}, userHome)).out)).toEqual([{ tool: 'claude', path: claude, status: 'unchanged' }]);
    writeFileSync(claude, 'edited');
    const refused = await run(['user', 'skill', 'install', '--claude', '--json'], {}, userHome);
    expect(refused.code).toBe(5);
    expect(JSON.parse(refused.out).error.code).toBe('SKILL_EXISTS');
    expect(readFileSync(claude, 'utf8')).toBe('edited');
    const forced = await run(['user', 'skill', 'install', '--claude', '--force', '--json'], {}, userHome);
    expect(JSON.parse(forced.out)[0].status).toBe('updated');
    expect(readFileSync(claude, 'utf8')).toBe(content);
  });
});
