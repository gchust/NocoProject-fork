/**
 * Minimal synchronous git plumbing for `nocoproject repo checkout` (the CLI is a short-lived
 * process, so blocking calls are fine). Output is redacted before it reaches an error message.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { CliError, EXIT } from '../cli/output.js';
import { redactText } from '../util/redact.js';

export interface GitResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const GIT_TIMEOUT_MS = 10 * 60_000;

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

/** Runs git and returns its result; never throws for a non-zero exit. */
export function gitTry(args: readonly string[], cwd?: string): GitResult {
  const proc = spawnSync('git', [...args], {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CliError('git is not installed or not on PATH', EXIT.other, 'GIT_NOT_FOUND');
    throw new CliError(`git ${args[0] ?? ''} failed: ${proc.error.message}`, EXIT.other, 'GIT_FAILED');
  }
  return { ok: proc.status === 0, code: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/** Runs git and throws a CliError (GIT_FAILED, exit 1) on failure. Returns trimmed stdout. */
export function git(args: readonly string[], cwd?: string): string {
  const r = gitTry(args, cwd);
  if (!r.ok) {
    const detail = redactText((r.stderr || r.stdout).trim()).slice(-2000);
    throw new CliError(`git ${args.slice(0, 3).join(' ')} failed: ${detail}`, EXIT.other, 'GIT_FAILED');
  }
  return r.stdout.trim();
}

export function gitOut(args: readonly string[], cwd?: string): string | null {
  const r = gitTry(args, cwd);
  return r.ok ? r.stdout.trim() : null;
}

export function refExists(repo: string, ref: string): boolean {
  return gitTry(['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_WAIT_MS = 10 * 60_000;
const LOCK_STALE_MS = 15 * 60_000;

/**
 * Serializes clone / fetch / worktree mutations on one bare cache across processes with a
 * `mkdir` lock next to it. A lock older than 15 minutes is considered abandoned.
 */
export function withDirLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new CliError(`timed out waiting for the repository cache lock ${lockPath}`, EXIT.other, 'REPO_LOCKED');
      sleepSync(200);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
