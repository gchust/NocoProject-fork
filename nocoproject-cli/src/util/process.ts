import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Finds an executable on PATH (plus optional extra dirs). Returns an absolute path or null. */
export function which(command: string, extraDirs: readonly string[] = []): string | null {
  if (isAbsolute(command)) return isExecutable(command) ? command : null;
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs `<path> --version` with a timeout and returns the first version-looking line. */
export async function probeVersion(path: string, args: readonly string[] = ['--version'], timeoutMs = 10_000): Promise<string | null> {
  const out = await probeOutput(path, args, timeoutMs);
  if (out === null) return null;
  const line = out.split('\n').map((l) => l.trim()).find((l) => /\d+\.\d+/.test(l));
  const match = line?.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return match ? match[0] : line ?? null;
}

/** Runs `<path> <args>` with a timeout and returns stdout + stderr, or null on failure / non-zero exit. */
export function probeOutput(path: string, args: readonly string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn(path, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Children are spawned detached, so -pid addresses the whole process group.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the process tree, wait up to `graceMs`, then SIGKILL whatever is left. */
export async function killProcessTree(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.pid === undefined) return;
  const pid = child.pid;
  signalGroup(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid) && child.exitCode !== null) return;
    if (!groupAlive(pid) && child.signalCode !== null) return;
    if (!groupAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (groupAlive(pid)) signalGroup(child, 'SIGKILL');
}

/** Keeps the last `max` characters written to it. */
export class TailBuffer {
  private text = '';
  constructor(private readonly max = 8192) {}
  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max) this.text = this.text.slice(this.text.length - this.max);
  }
  toString(): string {
    return this.text;
  }
}
