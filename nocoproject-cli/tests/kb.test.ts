import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockServer } from './helpers/mock-server.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const PROJECT = { id: 'p1', name: 'Demo', description: null, resources: [] };
let mock: MockServer;
let token: string;
let workDir: string;

beforeAll(async () => {
  mock = new MockServer();
  await mock.start();
  mock.runtimes.set('echo', { id: 'rt-echo', provider: 'echo' });
  mock.addIssue({ id: 'i40', identifier: 'NP-40', title: 'Knowledge issue' });
  mock.knowledge.add({ slug: 'api-conventions', title: 'API conventions', summary: 'Error envelope and naming.', projectId: 'p1', content: '# API conventions\n\nUse { code, message }.' });
  mock.knowledge.add({ slug: 'release-process', title: 'Release process', projectId: null, content: 'Tag, then deploy.\n' });
  mock.knowledge.add({ slug: 'other-project', title: 'Other', projectId: 'p2' });
  token = mock.issueToken('i40', { project: PROJECT });
  workDir = mkdtempSync(join(tmpdir(), 'ncp-kb-'));
});
afterAll(async () => mock.stop());

function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: workDir,
    env: { PATH: process.env.PATH, HOME: workDir, NOCOPROJECT_HOME: workDir, NOCOPROJECT_SERVER_URL: mock.url, NOCOPROJECT_TOKEN: token, NOCOPROJECT_ISSUE_ID: 'i40', NOCOPROJECT_ISSUE_KEY: 'NP-40' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

describe('kb list / get', () => {
  it('lists the project and system documents without content', async () => {
    const r = await run(['kb', 'list', '--json']);
    expect(r.code).toBe(0);
    const list = JSON.parse(r.out);
    expect(list.map((d: { slug: string }) => d.slug)).toEqual(['api-conventions', 'release-process']);
    expect(list[0].content).toBeUndefined();
    const text = await run(['kb', 'list']);
    expect(text.out).toContain('api-conventions  API conventions  (project, v1)\n  Error envelope and naming.');
    expect(text.out).toContain('release-process  Release process  (system, v1)');
  });

  it('searches the title, slug, summary and content with --q', async () => {
    // "deploy" is only in release-process's content, not its title, slug or (empty) summary.
    const r = await run(['kb', 'list', '--q', 'deploy', '--json']);
    expect(r.code).toBe(0);
    const list = JSON.parse(r.out);
    expect(list.map((d: { slug: string }) => d.slug)).toEqual(['release-process']);
    expect(list[0].matchExcerpt).toContain('deploy');

    // "api conventions" matches the title, which is already visible on the row: no excerpt needed.
    const byTitle = await run(['kb', 'list', '--q', 'api conventions', '--json']);
    expect(JSON.parse(byTitle.out)[0].matchExcerpt).toBeUndefined();

    // "code, message" is only in api-conventions's content.
    const byContent = await run(['kb', 'list', '--q', 'code, message', '--json']);
    const contentList = JSON.parse(byContent.out);
    expect(contentList.map((d: { slug: string }) => d.slug)).toEqual(['api-conventions']);
    expect(contentList[0].matchExcerpt).toContain('code, message');

    const text = await run(['kb', 'list', '--q', 'deploy']);
    expect(text.out).toContain('… ');

    expect((await run(['kb', 'list', '--q', 'nonexistent', '--json'])).out.trim()).toBe('[]');
  });

  it('prints the content by slug or id, and the whole document with --json', async () => {
    const bySlug = await run(['kb', 'get', 'api-conventions']);
    expect(bySlug.code).toBe(0);
    expect(bySlug.out).toBe('# API conventions\n\nUse { code, message }.\n');
    const id = mock.knowledge.docs[1]?.id as string;
    expect((await run(['kb', 'get', id])).out).toBe('Tag, then deploy.\n');
    const json = JSON.parse((await run(['kb', 'get', 'api-conventions', '--json'])).out);
    expect(json).toMatchObject({ slug: 'api-conventions', version: 1, content: '# API conventions\n\nUse { code, message }.' });
  });

  it('exits 4 for an unknown or invisible document', async () => {
    const r = await run(['kb', 'get', 'other-project', '--json']);
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out).error.code).toBe('KNOWLEDGE_NOT_FOUND');
  });
});

describe('kb propose', () => {
  it('proposes an update to an existing document by slug (docId resolved)', async () => {
    writeFileSync(join(workDir, 'kb.md'), '# API conventions\n\nUse { code, message } and cursor pagination.\n');
    const r = await run(['kb', 'propose', '--doc', 'api-conventions', '--content-file', 'kb.md', '--reason', 'Pagination is cursor-based now.', '--summary', 'Errors and pagination.', '--json']);
    expect(r.code).toBe(0);
    const proposal = JSON.parse(r.out);
    expect(proposal).toMatchObject({ status: 'pending', docId: mock.knowledge.docs[0]?.id });
    const call = mock.callsTo(/POST \/np\/agent\/knowledge\/proposals/).at(-1);
    expect(call?.body).toEqual({ docId: mock.knowledge.docs[0]?.id, summary: 'Errors and pagination.', content: '# API conventions\n\nUse { code, message } and cursor pagination.\n', reason: 'Pagination is cursor-based now.' });
  });

  it('maps a second pending proposal for the same document to exit 5', async () => {
    const r = await run(['kb', 'propose', '--doc', 'api-conventions', '--content-file', 'kb.md', '--reason', 'Again.', '--json']);
    expect(r.code).toBe(5);
    expect(JSON.parse(r.out).error.code).toBe('KNOWLEDGE_PROPOSAL_PENDING');
  });

  it('proposes a new document with a title and slug', async () => {
    writeFileSync(join(workDir, 'new.md'), '# Flaky tests\n\nRetry the e2e suite once.\n');
    const r = await run(['kb', 'propose', '--title', 'Flaky tests', '--slug', 'flaky-tests', '--content-file', 'new.md', '--reason', 'Saw it twice.']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^proposed new document "Flaky tests" \(proposal kp\d+, pending\)/);
    expect(mock.callsTo(/POST \/np\/agent\/knowledge\/proposals/).at(-1)?.body).toEqual({ title: 'Flaky tests', slug: 'flaky-tests', content: '# Flaky tests\n\nRetry the e2e suite once.\n', reason: 'Saw it twice.' });
  });

  it('validates the flags before calling the server', async () => {
    const before = mock.callsTo(/knowledge\/proposals/).length;
    const cases: [string[], string][] = [
      [['--content-file', 'new.md', '--reason', 'x'], 'INVALID_ARGUMENTS'],
      [['--doc', 'a', '--title', 'b', '--content-file', 'new.md', '--reason', 'x'], 'INVALID_ARGUMENTS'],
      [['--doc', 'a', '--slug', 's', '--content-file', 'new.md', '--reason', 'x'], 'INVALID_ARGUMENTS'],
      [['--title', 'T', '--slug', 'Bad Slug', '--content-file', 'new.md', '--reason', 'x'], 'INVALID_SLUG'],
      [['--title', 'T', '--content-file', 'new.md'], 'REASON_REQUIRED'],
      [['--title', 'T', '--content-file', 'new.md', '--reason', 'x'.repeat(501)], 'REASON_TOO_LONG'],
      [['--title', 'T', '--content-file', 'missing.md', '--reason', 'x'], 'FILE_NOT_FOUND'],
      [['--title', 'T', '--reason', 'x'], 'CONTENT_REQUIRED'],
    ];
    for (const [args, code] of cases) {
      const r = await run(['kb', 'propose', ...args, '--json']);
      expect(r.code, args.join(' ')).toBe(5);
      expect(JSON.parse(r.out).error.code, args.join(' ')).toBe(code);
    }
    expect(mock.callsTo(/knowledge\/proposals/).length).toBe(before);
  });
});
