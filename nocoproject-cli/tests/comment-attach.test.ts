/**
 * NP-215 `issue comment add --attach`: files are checked locally, uploaded one at a time with their MIME type and
 * attached to the comment (or thread reply) with `attachmentIds`; every refusal posts no comment.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildBrief } from '../src/daemon/brief.js';
import { mimeTypeOf } from '../src/cli/comment-attachments.js';
import { claimedRun } from './helpers/fixtures.js';
import { MockServer } from './helpers/mock-server.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let mock: MockServer;
let token: string;
let dir: string;

beforeAll(async () => {
  mock = new MockServer();
  await mock.start();
  mock.addIssue({ id: 'i9', identifier: 'NP-9', title: 'Screenshots' });
  mock.addIssue({ id: 'i10', identifier: 'NP-10', title: 'Other issue' });
  token = mock.issueToken('i9');
  // The CLI prints resolved paths; macOS's temporary directory is a symlink.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ncp-attach-')));
  writeFileSync(join(dir, 'reply.md'), 'See `login page.png`.');
  writeFileSync(join(dir, 'login page.png'), PNG);
  writeFileSync(join(dir, 'test.log'), 'line 1\nline 2\n');
  writeFileSync(join(dir, 'kilo.bin'), Buffer.alloc(1025));
  writeFileSync(join(dir, 'locked.log'), 'secret');
  chmodSync(join(dir, 'locked.log'), 0o000);
  mkdirSync(join(dir, 'folder'));
});
afterAll(async () => mock.stop());
beforeEach(() => {
  mock.uploads.denied = false;
  mock.uploads.legacy = false;
  mock.uploads.maxFileSize = 1024 * 1024;
  mock.uploads.proxyLimit = false;
});

function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, NOCOPROJECT_HOME: dir, NOCOPROJECT_KEYCHAIN: 'off', NOCOPROJECT_SERVER_URL: mock.url, NOCOPROJECT_TOKEN: token, NOCOPROJECT_ISSUE_ID: 'i9', NOCOPROJECT_ISSUE_KEY: 'NP-9' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

const comment = (...extra: string[]) => ['issue', 'comment', 'add', 'NP-9', '--content-file', 'reply.md', ...extra];
const uploadCalls = () => mock.callsTo(/POST \/np\/agent\/issues\/[^/]+\/uploads/).length;
const commentCalls = () => mock.callsTo(/POST \/np\/agent\/issues\/i9\/comments/).length;

describe('issue comment add --attach', () => {
  it('uploads an image and a log, then posts the comment with both', async () => {
    const before = mock.uploads.files.size;
    const r = await run(comment('--attach', 'login page.png', '--attach', join(dir, 'test.log')));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('comment posted with 2 attachments');
    const files = [...mock.uploads.files.values()].slice(before);
    expect(files.map(({ filename, mimeType, size, issueId }) => ({ filename, mimeType, size, issueId }))).toEqual([
      { filename: 'login page.png', mimeType: 'image/png', size: 8, issueId: 'i9' },
      { filename: 'test.log', mimeType: 'text/plain', size: 14, issueId: 'i9' },
    ]);
    expect(Buffer.from(files[0]!.bytes).equals(PNG)).toBe(true);
    const call = mock.callsTo(/POST \/np\/agent\/issues\/i9\/comments/).at(-1);
    expect(call?.body).toEqual({ content: 'See `login page.png`.', attachmentIds: files.map((file) => file.id) });
    expect(mock.comments.get('i9')?.at(-1)).toMatchObject({ attachments: [{ filename: 'login page.png' }, { filename: 'test.log' }] });
  });

  it('attaches a file to a thread reply', async () => {
    const root = await run(comment('--json'));
    const rootId = (JSON.parse(root.out) as { comment: { id: string } }).comment.id;
    const r = await run(comment('--parent', rootId, '--attach', 'test.log', '--json'));
    expect(r.code).toBe(0);
    const reply = (JSON.parse(r.out) as { comment: { parentId: string; rootId: string; attachments: { filename: string }[] } }).comment;
    expect(reply).toMatchObject({ parentId: rootId, rootId, attachments: [{ filename: 'test.log' }] });
    expect(mock.callsTo(/POST \/np\/agent\/issues\/i9\/comments/).at(-1)?.body).toMatchObject({ parentId: rootId, attachmentIds: [expect.any(String)] });
  });

  it('checks the files before uploading anything (exit 5)', async () => {
    const [uploads, comments] = [uploadCalls(), commentCalls()];
    const cases: [string[], string][] = [
      [['--attach', 'missing.png'], 'FILE_NOT_FOUND'],
      [['--attach', 'test.log', '--attach', 'folder'], 'NOT_A_FILE'],
      [['--attach', 'test.log', '--attach', join(dir, 'test.log')], 'DUPLICATE_ATTACHMENT'],
      [Array.from({ length: 11 }, (_, i) => ['--attach', `f${i}.txt`]).flat(), 'TOO_MANY_ATTACHMENTS'],
      // root reads any file, so this case only holds for an ordinary user
      ...(process.getuid?.() === 0 ? [] : [[['--attach', 'test.log', '--attach', 'locked.log'], 'FILE_NOT_READABLE'] as [string[], string]]),
    ];
    for (const [args, code] of cases) {
      const r = await run(comment(...args, '--json'));
      expect(r.code).toBe(5);
      expect(JSON.parse(r.out).error.code).toBe(code);
    }
    const text = await run(comment('--attach', 'missing.png'));
    expect(text.err.trim()).toBe(`error: attachment not found: ${join(dir, 'missing.png')}`);
    expect([uploadCalls(), commentCalls()]).toEqual([uploads, comments]);
  });

  it('explains a file over the server limit and posts nothing (exit 5)', async () => {
    mock.uploads.maxFileSize = 4;
    const comments = commentCalls();
    const r = await run(comment('--attach', 'login page.png'));
    expect(r.code).toBe(5);
    expect(r.err.trim()).toBe(`error: attachment too large: ${join(dir, 'login page.png')} is 8 B; the server accepts at most 4 B. No comment was posted.`);
    const j = await run(comment('--attach', 'login page.png', '--json'));
    expect(JSON.parse(j.out).error).toMatchObject({ code: 'ATTACHMENT_TOO_LARGE', exitCode: 5, details: { maxFileSize: 4 } });
    // Sizes that round alike are shown in bytes.
    mock.uploads.maxFileSize = 1024;
    const close = await run(comment('--attach', 'kilo.bin'));
    expect(close.err).toContain('kilo.bin is 1025 bytes; the server accepts at most 1024 bytes.');
    // A proxy's own 413 page carries neither the code nor the limit.
    mock.uploads.proxyLimit = true;
    const proxy = await run(comment('--attach', 'test.log'));
    expect(proxy.code).toBe(5);
    expect(proxy.err.trim()).toBe(`error: attachment too large: ${join(dir, 'test.log')} is 14 B; that is over the server’s limit. No comment was posted.`);
    expect(commentCalls()).toBe(comments);
  });

  it('adds "No comment was posted" to any other refusal', async () => {
    const r = await run(['issue', 'comment', 'add', 'NP-10', '--content-file', 'reply.md', '--attach', 'test.log', '--json']);
    expect(r.code).toBe(3);
    const error = JSON.parse(r.out).error as { code: string; message: string };
    expect(error.code).toBe('ISSUE_NOT_IN_RUN');
    expect(error.message).toMatch(/^uploading .*test\.log failed: .*ISSUE_NOT_IN_RUN.*\. No comment was posted\.$/);
    expect(mock.callsTo(/POST \/np\/agent\/issues\/i10\/comments/)).toHaveLength(0);
  });

  it('names the missing capability and posts nothing (exit 3)', async () => {
    mock.uploads.denied = true;
    const comments = commentCalls();
    const r = await run(comment('--attach', 'test.log', '--json'));
    expect(r.code).toBe(3);
    const error = JSON.parse(r.out).error as { code: string; message: string; details: unknown };
    expect(error).toMatchObject({ code: 'CAPABILITY_DENIED', details: { capability: 'attachment.upload' } });
    const text = await run(comment('--attach', 'test.log'));
    expect(text.err.trim()).toBe(
      'error: this run may not upload attachments (capability attachment.upload). An admin grants "Upload comment attachments" to the agent, and a grant applies from its next run; post the comment without --attach meanwhile. No comment was posted.',
    );
    expect(commentCalls()).toBe(comments);
  });

  it('tells a server without agent uploads apart (exit 4)', async () => {
    mock.uploads.legacy = true;
    const r = await run(comment('--attach', 'test.log', '--json'));
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out).error.code).toBe('ATTACHMENT_UPLOAD_UNSUPPORTED');
    const text = await run(comment('--attach', 'test.log'));
    expect(text.err.trim()).toBe('error: this NocoProject server does not accept attachments from agents yet; post the comment without --attach. No comment was posted.');
  });
});

describe('attachments in the brief', () => {
  it('sends previewable images and common files with their MIME type', () => {
    expect(['a.PNG', 'b.jpeg', 'c.jpg', 'd.webp', 'e.log', 'f.svg', 'g.html', 'README', 'h.bin'].map(mimeTypeOf)).toEqual([
      'image/png',
      'image/jpeg',
      'image/jpeg',
      'image/webp',
      'text/plain',
      'image/svg+xml',
      'text/html',
      'application/octet-stream',
      'application/octet-stream',
    ]);
  });

  it('explains attaching files only to runs that may upload and comment', () => {
    const run = claimedRun();
    const brief = buildBrief(run);
    expect(brief).toContain('## Attaching files');
    expect(brief).toContain('`nocoproject issue comment add NP-12 --content-file ./reply.md --attach ./login-page.png --attach ./test.log`');
    const without = (drop: string) => buildBrief({ ...run, agent: { ...run.agent, capabilities: run.agent.capabilities?.filter((c) => c !== drop) } });
    expect(without('attachment.upload')).not.toContain('## Attaching files');
    expect(without('comment.create')).not.toContain('## Attaching files');
  });
});
