/**
 * `nocoproject repo checkout <url>` (contract §I): a bare clone cache per repository plus one git
 * worktree per run workDir, on the branch `agent/<agentSlug>/<issue identifier>`.
 *
 * - Only URLs listed in the project's resources (`<workDir>/.nocoproject/context.json`) are allowed.
 * - Cache: `<home>/repos/<sha1(normalized url)>.git`, fetched with a remote-tracking refspec so
 *   remote heads never collide with the per-task branches that live in `refs/heads/*`.
 * - Worktree: `<workDir>/<repoName>/`. A later run resumes the branch: the same workDir reuses the
 *   worktree; a new workDir checks out the branch the server remembered (`session.branchName`).
 * - A same-named branch the session does not own gets a short run-key suffix (as Multica does).
 * - `--fresh` removes this workDir's worktree and resets the branch to the base ref.
 * - Never deletes other worktrees; a branch held by a dormant worktree elsewhere is detached there.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError, EXIT } from '../cli/output.js';
import type { CheckoutRecord, ClaimedProject } from '../protocol.js';
import { type RunContextFile, writeCheckoutRecord } from '../run-context.js';
import { redactText } from '../util/redact.js';
import { git, gitOut, gitTry, refExists, withDirLock } from './git.js';
import { branchNameFor, normalizeRepoUrl, repoCachePath, repoNameFromUrl, runKey, sameRepoUrl } from './naming.js';

export const AGENT_GIT_NAME = 'NocoProject Agent';
export const AGENT_GIT_EMAIL = 'agent@nocoproject.local';
const FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

export interface CheckoutOptions {
  readonly url: string;
  readonly ref?: string;
  readonly fresh?: boolean;
  readonly workDir: string;
  readonly context: RunContextFile;
  /** State directory (`~/.nocoproject`); the cache lives in `<home>/repos`. */
  readonly home: string;
  readonly runId?: string;
  /** Human-readable progress / warnings (the CLI prints them on stderr). */
  readonly note?: (message: string) => void;
}

type Resource = ClaimedProject['resources'][number];

interface BaseRef {
  /** Resolvable ref, e.g. `refs/remotes/origin/main`. */
  readonly ref: string;
  /** What we report as `ref`, e.g. `main`. */
  readonly name: string;
}

interface Placement {
  readonly bare: string;
  readonly path: string;
  readonly base: BaseRef;
  readonly repoUrl: string;
  readonly context: RunContextFile;
  readonly fresh: boolean;
  readonly runId?: string;
  readonly note: (message: string) => void;
}

export function findAllowedResource(context: RunContextFile | null, url: string): Resource | null {
  const resources = context?.project?.resources ?? [];
  const key = normalizeRepoUrl(url);
  return resources.find((r) => r.type === 'gitRepo' && normalizeRepoUrl(r.url) === key) ?? null;
}

function repoNotAllowed(context: RunContextFile | null, url: string): CliError {
  const allowed = (context?.project?.resources ?? []).map((r) => r.url);
  const hint = allowed.length ? `allowed: ${allowed.join(', ')}` : 'this issue’s project has no repositories';
  return new CliError(`repository ${redactText(url)} is not a resource of this issue’s project (${hint})`, EXIT.validation, 'REPO_NOT_ALLOWED');
}

function isBareRepo(path: string): boolean {
  if (!existsSync(join(path, 'HEAD')) || !existsSync(join(path, 'objects'))) return false;
  return gitOut(['-C', path, 'rev-parse', '--is-bare-repository']) === 'true';
}

function ensureBareCache(url: string, bare: string, note: (m: string) => void): void {
  if (!isBareRepo(bare)) {
    rmSync(bare, { recursive: true, force: true });
    note(`cloning ${redactText(url)} into the repository cache`);
    const cloned = gitTry(['clone', '--bare', '--quiet', url, bare]);
    if (!cloned.ok) {
      rmSync(bare, { recursive: true, force: true });
      throw new CliError(`git clone failed: ${redactText(cloned.stderr.trim()).slice(-2000)}`, EXIT.other, 'GIT_CLONE_FAILED');
    }
    git(['-C', bare, 'config', 'remote.origin.fetch', FETCH_REFSPEC]);
    git(['-C', bare, 'fetch', '--quiet', '--prune', 'origin']);
  } else {
    if (gitOut(['-C', bare, 'config', '--get', 'remote.origin.fetch']) !== FETCH_REFSPEC) {
      git(['-C', bare, 'config', 'remote.origin.fetch', FETCH_REFSPEC]);
    }
    const fetched = gitTry(['-C', bare, 'fetch', '--quiet', '--prune', 'origin']);
    if (!fetched.ok) note(`warning: git fetch failed, using the cached copy: ${redactText(fetched.stderr.trim()).slice(-500)}`);
  }
  gitTry(['-C', bare, 'remote', 'set-head', 'origin', '--auto']);
}

const ORIGIN = 'refs/remotes/origin/';

function defaultBranch(bare: string): string | null {
  const head = gitOut(['-C', bare, 'symbolic-ref', '--quiet', `${ORIGIN}HEAD`]);
  if (head?.startsWith(ORIGIN) && refExists(bare, head)) return head.slice(ORIGIN.length);
  const bareHead = gitOut(['-C', bare, 'symbolic-ref', '--quiet', 'HEAD']);
  if (bareHead?.startsWith('refs/heads/')) {
    const name = bareHead.slice('refs/heads/'.length);
    if (refExists(bare, `${ORIGIN}${name}`)) return name;
  }
  for (const name of ['main', 'master']) if (refExists(bare, `${ORIGIN}${name}`)) return name;
  const all = (gitOut(['-C', bare, 'for-each-ref', '--format=%(refname:strip=3)', ORIGIN]) ?? '')
    .split('\n')
    .filter((n) => n && n !== 'HEAD');
  return all.length === 1 ? (all[0] as string) : null;
}

function resolveBaseRef(bare: string, requested: string | null, url: string): BaseRef {
  if (requested) {
    for (const candidate of [`${ORIGIN}${requested}`, `refs/tags/${requested}`, requested]) {
      if (refExists(bare, candidate)) return { ref: candidate, name: requested };
    }
    throw new CliError(`cannot resolve ref "${requested}" in ${redactText(url)}`, EXIT.validation, 'REF_NOT_FOUND');
  }
  const name = defaultBranch(bare);
  if (!name) throw new CliError(`cannot resolve the default branch of ${redactText(url)} (empty repository?)`, EXIT.other, 'REF_NOT_FOUND');
  return { ref: `${ORIGIN}${name}`, name };
}

function isWorktree(path: string): boolean {
  try {
    return statSync(join(path, '.git')).isFile();
  } catch {
    return false;
  }
}

function branchExists(bare: string, branch: string): boolean {
  return refExists(bare, `refs/heads/${branch}`);
}

/** Worktree paths (other than the bare repo itself) that have `branch` checked out. */
function worktreesHolding(bare: string, branch: string): string[] {
  const out = gitOut(['-C', bare, 'worktree', 'list', '--porcelain']) ?? '';
  const holders: string[] = [];
  for (const block of out.split('\n\n')) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const lines = block.split('\n');
    if (path && lines.includes(`branch refs/heads/${branch}`) && !lines.includes('bare')) holders.push(path);
  }
  return holders;
}

/** Frees `branch` for a new worktree: prunes stale entries and detaches dormant holders. */
function releaseBranch(bare: string, branch: string, note: (m: string) => void): void {
  gitTry(['-C', bare, 'worktree', 'prune']);
  for (const holder of worktreesHolding(bare, branch)) {
    const r = gitTry(['-C', holder, 'checkout', '--quiet', '--detach']);
    if (r.ok) note(`detached ${branch} from the older checkout at ${holder} (files there are untouched)`);
    else throw new CliError(`branch ${branch} is checked out at ${holder} and could not be released: ${redactText(r.stderr.trim())}`, EXIT.other, 'BRANCH_IN_USE');
  }
}

function removeWorktree(bare: string, path: string, note: (m: string) => void): void {
  const r = gitTry(['-C', bare, 'worktree', 'remove', '--force', path]);
  if (!r.ok || existsSync(path)) rmSync(path, { recursive: true, force: true });
  gitTry(['-C', bare, 'worktree', 'prune']);
  note(`removed the existing checkout at ${path} (--fresh)`);
}

function fastForward(path: string, branch: string, base: BaseRef, note: (m: string) => void): void {
  const r = gitTry(['-C', path, 'merge', '--ff-only', '--quiet', base.ref]);
  if (!r.ok) note(`note: could not fast-forward ${branch} to ${base.name} (diverged or conflicting local changes); left it unchanged`);
}

function resumeExisting(p: Placement, target: string): string {
  let branch = gitOut(['-C', p.path, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) {
    if (branchExists(p.bare, target)) {
      releaseBranch(p.bare, target, p.note);
      git(['-C', p.path, 'checkout', '--quiet', target]);
    } else {
      git(['-C', p.path, 'checkout', '--quiet', '-b', target, p.base.ref]);
    }
    branch = target;
  }
  fastForward(p.path, branch, p.base, p.note);
  p.note(`reusing the existing checkout at ${p.path} on ${branch}`);
  return branch;
}

function addWorktree(p: Placement, args: readonly string[]): void {
  git(['-C', p.bare, 'worktree', 'add', '--quiet', ...args]);
}

/** Checks out the branch a previous run of this issue used. Returns null when it is gone. */
function resumeSessionBranch(p: Placement, branch: string): string | null {
  if (branchExists(p.bare, branch)) {
    releaseBranch(p.bare, branch, p.note);
    addWorktree(p, [p.path, branch]);
    fastForward(p.path, branch, p.base, p.note);
    p.note(`resumed branch ${branch}`);
    return branch;
  }
  if (refExists(p.bare, `${ORIGIN}${branch}`)) {
    addWorktree(p, ['-b', branch, p.path, `${ORIGIN}${branch}`]);
    p.note(`resumed branch ${branch} from origin`);
    return branch;
  }
  p.note(`previous branch ${branch} no longer exists; starting a new branch`);
  return null;
}

function createBranch(p: Placement, desired: string): string {
  let branch = desired;
  if (branchExists(p.bare, branch)) branch = `${desired}-${runKey(p.runId)}`;
  if (branchExists(p.bare, branch)) branch = `${desired}-${Date.now().toString(36)}`;
  const r = gitTry(['-C', p.bare, 'worktree', 'add', '--quiet', '-b', branch, p.path, p.base.ref]);
  if (!r.ok) {
    if (!/a branch named/i.test(r.stderr)) throw new CliError(`git worktree add failed: ${redactText(r.stderr.trim())}`, EXIT.other, 'GIT_FAILED');
    branch = `${desired}-${Date.now().toString(36)}`;
    addWorktree(p, ['-b', branch, p.path, p.base.ref]);
  }
  if (branch !== desired) p.note(`branch ${desired} already exists and is not this session’s; using ${branch}`);
  p.note(`created ${branch} from ${p.base.name}`);
  return branch;
}

/** Puts a worktree at `p.path` and returns the branch it is on. */
function placeWorktree(p: Placement): string {
  const desired = branchNameFor(p.context.agent.name, p.context.issue.identifier);
  const sessionBranch = sameRepoUrl(p.context.session.repoUrl, p.repoUrl) ? p.context.session.branchName : null;
  if (existsSync(p.path)) {
    if (!isWorktree(p.path)) {
      if (readdirSync(p.path).length > 0) {
        throw new CliError(`${p.path} exists and is not a git worktree; move it away first`, EXIT.validation, 'CHECKOUT_PATH_EXISTS');
      }
      rmSync(p.path, { recursive: true, force: true });
    } else if (p.fresh) {
      removeWorktree(p.bare, p.path, p.note);
    } else {
      return resumeExisting(p, sessionBranch ?? desired);
    }
  }
  gitTry(['-C', p.bare, 'worktree', 'prune']);
  if (p.fresh) {
    const branch = sessionBranch ?? desired;
    releaseBranch(p.bare, branch, p.note);
    addWorktree(p, ['-B', branch, p.path, p.base.ref]);
    p.note(`created ${branch} from ${p.base.name} (fresh)`);
    return branch;
  }
  const resumed = sessionBranch ? resumeSessionBranch(p, sessionBranch) : null;
  return resumed ?? createBranch(p, desired);
}

/**
 * Git requires core.bare / core.worktree to move out of the shared config before
 * `extensions.worktreeConfig` is enabled, or linked worktrees would inherit core.bare=true.
 */
function enableWorktreeConfig(bare: string): void {
  const config = join(bare, 'config');
  if (gitOut(['config', '--file', config, '--bool', '--get', 'extensions.worktreeConfig']) === 'true') return;
  for (const key of ['core.bare', 'core.worktree']) {
    const value = gitOut(['config', '--file', config, '--get', key]);
    if (value === null) continue;
    git(['config', '--file', join(bare, 'config.worktree'), key, value]);
    git(['config', '--file', config, '--unset-all', key]);
  }
  git(['config', '--file', config, 'extensions.worktreeConfig', 'true']);
}

/** Without touching global config: if the worktree has no identity, set a worktree-local fallback. */
function ensureIdentity(bare: string, path: string, note: (m: string) => void): void {
  const name = gitOut(['-C', path, 'config', '--get', 'user.name']);
  const email = gitOut(['-C', path, 'config', '--get', 'user.email']);
  if (name && email) return;
  enableWorktreeConfig(bare);
  git(['-C', path, 'config', '--worktree', 'user.name', AGENT_GIT_NAME]);
  git(['-C', path, 'config', '--worktree', 'user.email', AGENT_GIT_EMAIL]);
  note(`no git identity configured; using ${AGENT_GIT_NAME} <${AGENT_GIT_EMAIL}> in this worktree`);
}

/** Runs the checkout and writes `<workDir>/.nocoproject/checkout.json`. */
export function checkoutRepo(opts: CheckoutOptions): CheckoutRecord {
  const resource = findAllowedResource(opts.context, opts.url);
  if (!resource) throw repoNotAllowed(opts.context, opts.url);
  const note = opts.note ?? (() => undefined);
  const bare = repoCachePath(opts.home, resource.url);
  mkdirSync(dirname(bare), { recursive: true, mode: 0o700 });
  const record = withDirLock(`${bare}.lock`, (): CheckoutRecord => {
    ensureBareCache(resource.url, bare, note);
    const base = resolveBaseRef(bare, opts.ref ?? resource.defaultRef ?? null, resource.url);
    const path = join(opts.workDir, repoNameFromUrl(resource.url));
    const placement: Placement = { bare, path, base, repoUrl: resource.url, context: opts.context, fresh: Boolean(opts.fresh), runId: opts.runId, note };
    const branchName = placeWorktree(placement);
    ensureIdentity(bare, path, note);
    return { url: resource.url, ref: base.name, branchName, path };
  });
  writeCheckoutRecord(opts.workDir, record);
  return record;
}
