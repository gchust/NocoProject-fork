/**
 * Local git fixtures for repo checkout tests: a bare "remote" with one commit on main,
 * no network involved.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContextFile } from '../../src/run-context.js';

const SEED = ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com'];

export function sh(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface Remote {
  readonly root: string;
  readonly url: string;
  readonly seed: string;
}

/** Creates `<root>/remote/demo-repo.git` with a README commit on `main`. */
export function createRemote(): Remote {
  const root = mkdtempSync(join(tmpdir(), 'ncp-git-'));
  const url = join(root, 'remote', 'demo-repo.git');
  mkdirSync(url, { recursive: true });
  sh(['init', '--bare', '--quiet', '-b', 'main', url]);
  const seed = join(root, 'seed');
  sh(['clone', '--quiet', url, seed]);
  sh(['checkout', '--quiet', '-B', 'main'], seed);
  writeFileSync(join(seed, 'README.md'), '# demo\n');
  sh([...SEED, 'add', '-A'], seed);
  sh([...SEED, 'commit', '--quiet', '-m', 'initial'], seed);
  sh(['push', '--quiet', 'origin', 'main'], seed);
  return { root, url, seed };
}

/** Pushes another commit to the remote's main branch. */
export function pushUpstream(remote: Remote, file: string): void {
  writeFileSync(join(remote.seed, file), `${file}\n`);
  sh([...SEED, 'add', '-A'], remote.seed);
  sh([...SEED, 'commit', '--quiet', '-m', `add ${file}`], remote.seed);
  sh(['push', '--quiet', 'origin', 'main'], remote.seed);
}

/** Commits a file inside a checkout with an explicit identity. */
export function commitIn(path: string, file: string): void {
  writeFileSync(join(path, file), `${file}\n`);
  sh(['add', '-A'], path);
  sh(['commit', '--quiet', '-m', `add ${file}`], path);
}

export function runContext(url: string, overrides: Partial<RunContextFile> = {}): RunContextFile {
  return {
    version: 1,
    runId: '7301234567890123',
    agent: { id: 'agent-1', name: 'Echo Bot', delegationTargets: [], kind: 'coder' },
    issue: { id: 'i12', identifier: 'NP-12', title: 'Fix it', parent: null, stage: null, autoExecuteSubtasks: false, projectId: 'p1', executionMode: 'task', pullRequests: [], process: 'direct', designApprovedAt: null },
    project: { id: 'p1', name: 'Demo', description: null, resources: [{ type: 'gitRepo', url, defaultRef: null }] },
    knowledge: [],
    session: { branchName: null, repoUrl: null },
    ...overrides,
  };
}
