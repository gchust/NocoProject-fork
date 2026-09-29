import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pmIssuesQuery, sinceToIso } from '../src/cli/pm.js';
import { MockServer } from './helpers/mock-server.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
let mock: MockServer;
let managerToken: string;
let coderToken: string;
let workDir: string;

beforeAll(async () => {
  mock = new MockServer();
  await mock.start();
  mock.runtimes.set('echo', { id: 'rt-echo', provider: 'echo' });
  mock.addIssue({ id: 'i60', identifier: 'NP-60', title: 'PM conversation', statusKey: 'in_progress' });
  mock.addIssue({ id: 'i61', identifier: 'NP-61', title: 'Login redirect', description: 'Safari bug', statusKey: 'in_review', projectId: 'p1' });
  mock.addIssue({ id: 'i62', identifier: 'NP-62', title: 'Billing export', statusKey: 'todo', projectId: 'p2', ownerUserId: '2', updatedAt: '2026-01-01T00:00:00.000Z' });
  mock.addIssue({ id: 'i63', identifier: 'NP-63', title: 'Design the importer', statusKey: 'todo', process: 'design_first', designApprovedAt: null });
  mock.pm.projects.push({ id: 'p1', name: 'NocoProject', status: 'active', leadName: 'Alice', issueCounts: { total: 3, done: 1, byStatus: {} } });
  mock.pm.inbox.push({ id: 'n1', kind: 'decision', type: 'design_review', issueIdentifier: 'NP-63', title: 'Review the importer design' });
  mock.knowledge.add({ slug: 'api-conventions', title: 'API conventions', projectId: 'p1', projectName: 'NocoProject' });
  mock.knowledge.add({ slug: 'billing', title: 'Billing', projectId: 'p2' });
  managerToken = mock.issueToken('i60', { agentExtras: { kind: 'manager', reasoningEffort: 'high' } });
  coderToken = mock.issueToken('i63');
  workDir = mkdtempSync(join(tmpdir(), 'ncp-pm-'));
});
afterAll(async () => mock.stop());

function run(args: string[], token = managerToken, issue: [string, string] = ['i60', 'NP-60']): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: workDir,
    env: { PATH: process.env.PATH, HOME: workDir, NOCOPROJECT_HOME: workDir, NOCOPROJECT_SERVER_URL: mock.url, NOCOPROJECT_TOKEN: token, NOCOPROJECT_ISSUE_ID: issue[0], NOCOPROJECT_ISSUE_KEY: issue[1] },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

describe('pm flags', () => {
  it('turns --since into an ISO timestamp', () => {
    const now = Date.parse('2026-10-08T00:00:00.000Z');
    expect(sinceToIso('7d', now)).toBe('2026-10-01T00:00:00.000Z');
    expect(sinceToIso('12h', now)).toBe('2026-10-07T12:00:00.000Z');
    expect(sinceToIso('2w', now)).toBe('2026-09-24T00:00:00.000Z');
    expect(sinceToIso('2026-09-01', now)).toBe('2026-09-01T00:00:00.000Z');
    expect(() => sinceToIso('yesterday', now)).toThrow(/invalid --since/);
  });

  it('sends only the given filters', () => {
    const now = Date.parse('2026-10-08T00:00:00.000Z');
    expect(pmIssuesQuery({})).toEqual({});
    expect(pmIssuesQuery({ project: 'p1', status: 'todo', owner: 'me', executor: 'a1', q: 'x', since: '1d', limit: 5, cursor: '5' }, now)).toEqual({
      projectId: 'p1',
      statusKey: 'todo',
      ownerUserId: 'me',
      executorId: 'a1',
      q: 'x',
      updatedSince: '2026-10-07T00:00:00.000Z',
      limit: 5,
      cursor: '5',
    });
  });
});

describe('pm commands (manager agent)', () => {
  it('lists projects', async () => {
    const r = await run(['pm', 'projects', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)[0]).toMatchObject({ id: 'p1', name: 'NocoProject' });
    expect((await run(['pm', 'projects'])).out).toContain('NocoProject  (p1, active, 1/3 done, lead Alice)');
  });

  it('searches issues with filters and pages with --cursor', async () => {
    const all = JSON.parse((await run(['pm', 'issues', '--json'])).out);
    expect(all.data).toHaveLength(4);
    expect(all.nextCursor).toBeNull();
    const filtered = JSON.parse((await run(['pm', 'issues', '--project', 'p1', '--status', 'in_review', '--q', 'safari', '--json'])).out);
    expect(filtered.data.map((i: { identifier: string }) => i.identifier)).toEqual(['NP-61']);
    const call = mock.callsTo(/GET \/np\/agent\/pm\/issues\?/).at(-1);
    expect(call?.path).toContain('projectId=p1');
    expect(call?.path).toContain('statusKey=in_review');
    const mine = JSON.parse((await run(['pm', 'issues', '--owner', 'me', '--since', '7d', '--json'])).out);
    expect(mine.data.map((i: { identifier: string }) => i.identifier)).not.toContain('NP-62');
    expect(mock.callsTo(/GET \/np\/agent\/pm\/issues\?/).at(-1)?.path).toMatch(/ownerUserId=me&updatedSince=\d{4}-/);
    const page = JSON.parse((await run(['pm', 'issues', '--limit', '3', '--json'])).out);
    expect(page.nextCursor).toBe('3');
    expect((await run(['pm', 'issues', '--limit', '3'])).out).toContain('more: --cursor 3');
    const next = JSON.parse((await run(['pm', 'issues', '--limit', '3', '--cursor', '3', '--json'])).out);
    expect(next).toMatchObject({ nextCursor: null, data: [{ identifier: 'NP-63' }] });
  });

  it('reads one issue in full', async () => {
    const detail = JSON.parse((await run(['pm', 'issue', 'NP-61', '--json'])).out);
    expect(Object.keys(detail).sort()).toEqual(['activities', 'comments', 'issue', 'pullRequests', 'runs', 'subtasks']);
    expect(detail.issue).toMatchObject({ identifier: 'NP-61', statusKey: 'in_review' });
    const text = (await run(['pm', 'issue', 'NP-61'])).out;
    expect(text).toContain('NP-61  Login redirect');
    expect(text).toContain('Safari bug');
    expect((await run(['pm', 'issue', 'NP-999', '--json'])).code).toBe(4);
  });

  it('reads the inbox, metrics and knowledge', async () => {
    expect(JSON.parse((await run(['pm', 'inbox', '--json'])).out)).toEqual([expect.objectContaining({ type: 'design_review' })]);
    expect(mock.callsTo(/GET \/np\/agent\/pm\/inbox/).at(-1)?.path).toBe('/np/agent/pm/inbox?kind=decision');
    const metrics = JSON.parse((await run(['pm', 'metrics', '--from', '2026-09-01', '--to', '2026-09-30', '--json'])).out);
    expect(metrics).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect((await run(['pm', 'metrics', '--from', '09/01', '--json'])).code).toBe(5);
    expect((await run(['pm', 'metrics'])).out).toContain('AI share: 75% (3/4 delivered)');
    const docs = JSON.parse((await run(['pm', 'knowledge', '--json'])).out);
    expect(docs.map((d: { slug: string }) => d.slug)).toEqual(['api-conventions', 'billing']);
    expect(docs[0].content).toBeUndefined();
    expect(JSON.parse((await run(['pm', 'knowledge', '--project', 'p2', '--json'])).out).map((d: { slug: string }) => d.slug)).toEqual(['billing']);
  });

  it('exits 3 with a clear message for a non-manager agent', async () => {
    const r = await run(['pm', 'issues', '--json'], coderToken, ['i63', 'NP-63']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).error).toMatchObject({ code: 'MANAGER_ONLY', exitCode: 3 });
    const text = await run(['pm', 'projects'], coderToken, ['i63', 'NP-63']);
    expect(text.code).toBe(3);
    expect(text.err).toContain('requires workspace.read');
    expect(`${r.out}${text.err}`).not.toContain(coderToken);
  });
});

describe('issue design-proposal', () => {
  it('posts the proposal as a proposal comment', async () => {
    writeFileSync(join(workDir, 'proposal.md'), '## 需求理解\nImport CSV.\n');
    const r = await run(['issue', 'design-proposal', 'NP-63', '--content-file', 'proposal.md', '--json'], coderToken, ['i63', 'NP-63']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ kind: 'proposal', content: '## 需求理解\nImport CSV.\n' });
    expect(mock.callsTo(/POST \/np\/agent\/issues\/i63\/design-proposal/).at(-1)?.body).toEqual({ content: '## 需求理解\nImport CSV.\n' });
    const text = await run(['issue', 'design-proposal', 'NP-63', '--content-file', 'proposal.md'], coderToken, ['i63', 'NP-63']);
    expect(text.out).toMatch(/^design proposal posted \(comment cp\d+\); now set the status to proposal_review/);
  });

  it('validates the content file and the design gate', async () => {
    const missing = await run(['issue', 'design-proposal', 'NP-63', '--json'], coderToken, ['i63', 'NP-63']);
    expect(missing.code).toBe(5);
    expect(JSON.parse(missing.out).error.code).toBe('CONTENT_REQUIRED');
    writeFileSync(join(workDir, 'empty.md'), '  \n');
    const empty = await run(['issue', 'design-proposal', '--content-file', 'empty.md', '--json'], coderToken, ['i63', 'NP-63']);
    expect(JSON.parse(empty.out).error.code).toBe('EMPTY_CONTENT');
    const gated = await run(['issue', 'status', 'in_progress', '--json'], coderToken, ['i63', 'NP-63']);
    expect(gated.code).toBe(5);
    expect(JSON.parse(gated.out).error.code).toBe('DESIGN_NOT_APPROVED');
  });
});
