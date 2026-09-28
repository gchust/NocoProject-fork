import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeRunContext } from '../src/run-context.js';
import { MockServer } from './helpers/mock-server.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const PROJECT = { id: 'p1', name: 'Demo', description: 'Demo project', resources: [{ type: 'gitRepo' as const, url: 'https://github.com/acme/demo.git', defaultRef: 'main' }] };
let mock: MockServer;
let token: string;
let workDir: string;

beforeAll(async () => {
  mock = new MockServer();
  await mock.start();
  mock.runtimes.set('echo', { id: 'rt-echo', provider: 'echo' });
  mock.addIssue({ id: 'i20', identifier: 'NP-20', title: 'Parent issue' });
  mock.addIssue({ id: 'i21', identifier: 'NP-21', title: 'Blocker' });
  mock.addIssue({ id: 'i22', identifier: 'NP-22', title: 'Other blocker' });
  mock.addIssue({ id: 'i5', identifier: 'NP-5', title: 'Grandparent' });
  token = mock.issueToken('i20', { project: PROJECT, agentExtras: { delegationTargets: [{ id: 'agent-9', name: 'Reviewer' }] }, issueExtras: { parent: { id: 'i5', identifier: 'NP-5', title: 'Grandparent' } } });
  const claimed = [...mock.runs.values()].find((r) => r.claimed.token === token)?.claimed;
  workDir = mkdtempSync(join(tmpdir(), 'ncp-sub-'));
  if (claimed) writeRunContext(workDir, claimed);
});
afterAll(async () => mock.stop());

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      HOME: workDir,
      NOCOPROJECT_HOME: workDir,
      NOCOPROJECT_SERVER_URL: mock.url,
      NOCOPROJECT_TOKEN: token,
      NOCOPROJECT_ISSUE_ID: 'i20',
      NOCOPROJECT_ISSUE_KEY: 'NP-20',
      NOCOPROJECT_WORKDIR: workDir,
      ...env,
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

describe('issue create', () => {
  it('creates a sub-issue with every flag and resolves identifiers', async () => {
    writeFileSync(join(workDir, 'sub.md'), '## Plan\nDo part one.');
    const r = await run([
      'issue', 'create', '--title', 'Part one', '--description-file', 'sub.md', '--parent', 'NP-20', '--stage', '1',
      '--blocked-by', 'NP-21, i22', '--executor', 'self', '--priority', 'high', '--label', 'backend,api', '--json',
    ]);
    expect(r.code).toBe(0);
    const created = JSON.parse(r.out);
    expect(created).toMatchObject({ identifier: expect.stringMatching(/^NP-\d+$/), title: 'Part one', parentIssueId: 'i20', stage: 1 });
    const call = mock.callsTo(/POST \/np\/agent\/issues$/).at(-1);
    expect(call?.body).toEqual({
      title: 'Part one', description: '## Plan\nDo part one.', parentIssueId: 'i20', stage: 1, blockedBy: ['i21', 'i22'], priority: 'high', labels: ['backend', 'api'], executor: 'self',
    });
  });

  it('sends only the title by default and maps delegation names and the parent identifier locally', async () => {
    const r = await run(['issue', 'create', '--title', 'Minimal']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^created NP-\d+ "Minimal"/);
    expect(mock.callsTo(/POST \/np\/agent\/issues$/).at(-1)?.body).toEqual({ title: 'Minimal' });
    const before = mock.callsTo(/GET \/np\/agent\/issues\/NP-5$/).length;
    const d = await run(['issue', 'create', '--title', 'For reviewer', '--executor', 'reviewer', '--parent', 'NP-5', '--description', 'inline', '--json']);
    expect(d.code).toBe(0);
    expect(mock.callsTo(/POST \/np\/agent\/issues$/).at(-1)?.body).toEqual({ title: 'For reviewer', description: 'inline', parentIssueId: 'i5', executor: 'agent-9' });
    expect(mock.callsTo(/GET \/np\/agent\/issues\/NP-5$/).length).toBe(before);
  });

  it('validates input with exit 5 and unknown blockers with exit 4', async () => {
    expect((await run(['issue', 'create', '--json'])).code).toBe(5);
    expect((await run(['issue', 'create', '--title', 'x', '--description', 'a', '--description-file', 'b', '--json'])).code).toBe(5);
    expect((await run(['issue', 'create', '--title', 'x', '--priority', 'asap', '--json'])).code).toBe(5);
    expect((await run(['issue', 'create', '--title', 'x', '--stage', '-1', '--json'])).code).toBe(5);
    expect((await run(['issue', 'create', '--title', 'x', '--description-file', 'missing.md', '--json'])).code).toBe(5);
    const r = await run(['issue', 'create', '--title', 'x', '--blocked-by', 'NP-999', '--json']);
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out).error.code).toBe('ISSUE_NOT_FOUND');
  });
});

describe('issue children and dependencies', () => {
  it('lists children as JSON and text', async () => {
    const r = await run(['issue', 'children', 'NP-20', '--json']);
    expect(r.code).toBe(0);
    const children = JSON.parse(r.out) as { identifier: string; stage: number | null; blockedCount: number }[];
    expect(children.find((c) => c.stage === 1)).toMatchObject({ blockedCount: 2 });
    const text = await run(['issue', 'children']);
    expect(text.out).toMatch(/NP-\d+ {2}\[stage 1\] {2}todo {2}Part one — Echo Bot {2}\(waiting on 2\)/);
    expect(text.out).toContain('[no stage]');
  });

  it('adds and removes blocked-by dependencies by identifier', async () => {
    const add = await run(['issue', 'dependency', 'add', 'NP-20', '--blocked-by', 'NP-21', '--json']);
    expect(add.code).toBe(0);
    expect(mock.callsTo(/POST \/np\/agent\/issues\/i20\/dependencies/).at(-1)?.body).toEqual({ dependsOnIssueId: 'i21', type: 'blockedBy' });
    const remove = await run(['issue', 'dependency', 'remove', '--blocked-by', 'NP-21']);
    expect(remove.code).toBe(0);
    expect(remove.out).toContain('removed 1 blocked-by dependency');
    expect(mock.callsTo(/DELETE \/np\/agent\/issues\/i20\/dependencies\?dependsOnIssueId=i21&type=blockedBy/).length).toBe(1);
    const missing = await run(['issue', 'dependency', 'remove', 'NP-20', '--blocked-by', 'NP-21', '--json']);
    expect(missing.code).toBe(4);
  });
});

describe('project get', () => {
  it('reads the project from context.json without calling the server', async () => {
    const before = mock.callsTo(/agent\/context/).length;
    const r = await run(['project', 'get', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(PROJECT);
    const text = await run(['project', 'get']);
    expect(text.out).toContain('nocoproject repo checkout https://github.com/acme/demo.git');
    expect(mock.callsTo(/agent\/context/).length).toBe(before);
  });

  it('falls back to GET /np/agent/context outside a workDir', async () => {
    const r = await run(['project', 'get', '--json'], { NOCOPROJECT_WORKDIR: mkdtempSync(join(tmpdir(), 'ncp-empty-')) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(PROJECT);
  });
});
