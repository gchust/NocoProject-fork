import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../src/cli/output.js';
import { AGENT_GIT_EMAIL, AGENT_GIT_NAME, checkoutRepo, findAllowedResource } from '../src/repo/checkout.js';
import { agentSlug, branchNameFor, normalizeRepoUrl, repoCachePath, repoNameFromUrl, runKey } from '../src/repo/naming.js';
import { readCheckoutRecord, type RunContextFile, writeRunContext } from '../src/run-context.js';
import { commitIn, createRemote, pushUpstream, type Remote, runContext, sh } from './helpers/git-fixture.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const saved: Record<string, string | undefined> = {};
let remote: Remote;
let home: string;
let globalConfig: string;

beforeAll(() => {
  // Isolate from the developer's git identity so the worktree fallback is exercised.
  const isolated = mkdtempSync(join(tmpdir(), 'ncp-gitcfg-'));
  globalConfig = join(isolated, 'gitconfig');
  writeFileSync(globalConfig, '');
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  remote = createRemote();
  home = join(remote.root, 'home');
});

function newWorkDir(): string {
  return mkdtempSync(join(remote.root, 'wd-'));
}

function checkout(workDir: string, context: RunContextFile, extra: { fresh?: boolean; ref?: string; runId?: string; url?: string } = {}) {
  const notes: string[] = [];
  const record = checkoutRepo({ url: extra.url ?? remote.url, workDir, context, home, fresh: extra.fresh, ref: extra.ref, runId: extra.runId, note: (m) => notes.push(m) });
  return { record, notes };
}

const log = (path: string) => sh(['log', '--format=%s'], path).split('\n');

describe('repo naming', () => {
  it('normalizes URLs, names repos, slugs agents and builds branch names', () => {
    expect(normalizeRepoUrl('HTTPS://GitHub.com/Org/Repo.git/')).toBe('https://github.com/org/repo');
    expect(repoNameFromUrl('git@github.com:org/my-repo.git')).toBe('my-repo');
    expect(repoNameFromUrl('https://github.com/org/my-repo')).toBe('my-repo');
    expect(agentSlug('Échο Bot #1 !!')).toBe('ch-bot-1');
    expect(agentSlug('***')).toBe('agent');
    expect(branchNameFor('Echo Bot', 'NP-12')).toBe('agent/echo-bot/np-12');
    expect(runKey('7301234567890123')).toBe('67890123');
    expect(repoCachePath('/h', 'https://x/y.git')).toBe(repoCachePath('/h', 'HTTPS://X/Y'));
    expect(repoCachePath('/h', 'https://x/y.git')).toMatch(/^\/h\/repos\/[0-9a-f]{40}\.git$/);
  });
});

describe('repo checkout', () => {
  it('creates the agent branch in a worktree, writes checkout.json and sets a worktree-local identity', () => {
    const workDir = newWorkDir();
    const { record } = checkout(workDir, runContext(remote.url));
    const path = join(workDir, 'demo-repo');
    expect(record).toEqual({ url: remote.url, ref: 'main', branchName: 'agent/echo-bot/np-12', path });
    expect(readCheckoutRecord(workDir)).toEqual(record);
    expect(statSync(join(workDir, '.nocoproject', 'checkout.json')).mode & 0o777).toBe(0o600);
    expect(sh(['symbolic-ref', '--short', 'HEAD'], path)).toBe('agent/echo-bot/np-12');
    expect(existsSync(join(path, 'README.md'))).toBe(true);
    expect(statSync(join(path, '.git')).isFile()).toBe(true);
    expect(sh(['config', 'user.name'], path)).toBe(AGENT_GIT_NAME);
    expect(sh(['config', 'user.email'], path)).toBe(AGENT_GIT_EMAIL);
    expect(readFileSync(globalConfig, 'utf8')).toBe('');
    const bare = repoCachePath(home, remote.url);
    expect(sh(['rev-parse', '--is-bare-repository'], bare)).toBe('true');
    expect(sh(['rev-parse', '--is-bare-repository'], path)).toBe('false');
    commitIn(path, 'work.txt');
    expect(log(path)[0]).toBe('add work.txt');
  });

  it('resumes the same worktree on a later run and fast-forwards to upstream', () => {
    const workDir = newWorkDir();
    checkout(workDir, runContext(remote.url));
    pushUpstream(remote, 'upstream.txt');
    const { record, notes } = checkout(workDir, runContext(remote.url));
    expect(record.branchName).toBe('agent/echo-bot/np-12');
    expect(existsSync(join(record.path, 'upstream.txt'))).toBe(true);
    expect(notes.join('\n')).toContain('reusing the existing checkout');
    commitIn(record.path, 'mine.txt');
    pushUpstream(remote, 'more.txt');
    const again = checkout(workDir, runContext(remote.url));
    expect(log(again.record.path)[0]).toBe('add mine.txt');
    expect(again.notes.join('\n')).toContain('could not fast-forward');
  });

  it('resumes session.branchName in a new workDir and detaches the dormant old checkout', () => {
    const first = newWorkDir();
    const { record } = checkout(first, runContext(remote.url));
    commitIn(record.path, 'progress.txt');
    const second = newWorkDir();
    const ctx = runContext(remote.url, { session: { branchName: record.branchName, repoUrl: `${remote.url.toUpperCase()}/` } });
    const resumed = checkout(second, ctx);
    expect(resumed.record.branchName).toBe('agent/echo-bot/np-12');
    expect(resumed.record.path).toBe(join(second, 'demo-repo'));
    expect(log(resumed.record.path)[0]).toBe('add progress.txt');
    expect(existsSync(join(record.path, 'progress.txt'))).toBe(true);
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], record.path)).toBe('HEAD');
  });

  it('appends a run key when a foreign branch with the same name exists', () => {
    const first = newWorkDir();
    checkout(first, runContext(remote.url));
    const second = newWorkDir();
    const { record, notes } = checkout(second, runContext(remote.url), { runId: '7301234567899999' });
    expect(record.branchName).toBe('agent/echo-bot/np-12-67899999');
    expect(notes.join('\n')).toContain('already exists');
    expect(sh(['symbolic-ref', '--short', 'HEAD'], record.path)).toBe('agent/echo-bot/np-12-67899999');
  });

  it('--fresh recreates the checkout and resets the branch to the base ref', () => {
    const workDir = newWorkDir();
    const { record } = checkout(workDir, runContext(remote.url));
    commitIn(record.path, 'discard-me.txt');
    writeFileSync(join(record.path, 'untracked.txt'), 'x');
    const fresh = checkout(workDir, runContext(remote.url), { fresh: true });
    expect(fresh.record.branchName).toBe('agent/echo-bot/np-12');
    expect(existsSync(join(fresh.record.path, 'discard-me.txt'))).toBe(false);
    expect(existsSync(join(fresh.record.path, 'untracked.txt'))).toBe(false);
    expect(log(fresh.record.path)).toEqual(['initial']);
  });

  it('checks out an explicit --ref', () => {
    sh(['push', '--quiet', 'origin', 'main:release'], remote.seed);
    pushUpstream(remote, 'only-on-main.txt');
    const { record } = checkout(newWorkDir(), runContext(remote.url), { ref: 'release' });
    expect(record.ref).toBe('release');
    expect(existsSync(join(record.path, 'only-on-main.txt'))).toBe(false);
    expect(() => checkout(newWorkDir(), runContext(remote.url), { ref: 'nope' })).toThrow(/cannot resolve ref "nope"/);
  });

  it('rejects URLs that are not project resources with REPO_NOT_ALLOWED (exit 5)', () => {
    expect(findAllowedResource(runContext(remote.url), `${remote.url.toUpperCase()}`)).not.toBeNull();
    let error: unknown;
    try {
      checkout(newWorkDir(), runContext(remote.url), { url: 'https://github.com/evil/repo.git' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 'REPO_NOT_ALLOWED', exitCode: 5 });
    expect(() => checkout(newWorkDir(), runContext(remote.url, { project: null }))).toThrow(/has no repositories/);
  });
});

describe('repo checkout CLI', () => {
  function cli(args: string[], workDir: string) {
    const env = { ...process.env, NOCOPROJECT_HOME: home, NOCOPROJECT_WORKDIR: workDir };
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: workDir, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it('checks out with --json and exits 5 for a disallowed URL', () => {
    const workDir = newWorkDir();
    writeRunContext(workDir, {
      run: { id: '99', agentId: 'agent-1', runtimeId: 'rt', attempt: 1, priority: 0, createdAt: '' },
      token: 'npr_x',
      agent: { id: 'agent-1', name: 'Echo Bot', instructions: '', provider: 'echo', model: null },
      issue: { id: 'i12', identifier: 'NP-12', title: 't', statusKey: 'todo', ownerName: 'A' },
      statusCatalog: [],
      agentTransitions: [],
      triggers: [],
      session: { providerSessionId: null, workDir: null, fresh: true },
      server: { url: '', protocolVersion: 1 },
      leaseSeconds: 45,
      project: { id: 'p1', name: 'Demo', description: null, resources: [{ type: 'gitRepo', url: remote.url, defaultRef: 'main' }] },
    });
    const ok = cli(['repo', 'checkout', remote.url, '--json'], workDir);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual({ url: remote.url, ref: 'main', branchName: 'agent/echo-bot/np-12', path: join(workDir, 'demo-repo') });
    const text = cli(['repo', 'checkout', remote.url], workDir);
    expect(text.out.trim()).toBe(join(workDir, 'demo-repo'));
    const bad = cli(['repo', 'checkout', 'https://example.com/x.git', '--json'], workDir);
    expect(bad.code).toBe(5);
    expect(JSON.parse(bad.out).error.code).toBe('REPO_NOT_ALLOWED');
    const noContext = cli(['repo', 'checkout', remote.url, '--json'], newWorkDir());
    expect(noContext.code).toBe(5);
    expect(JSON.parse(noContext.out).error.code).toBe('CONTEXT_MISSING');
  });
});
