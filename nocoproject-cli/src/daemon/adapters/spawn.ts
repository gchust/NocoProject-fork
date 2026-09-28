/**
 * Shared process plumbing for adapters: spawns the tool in its own process group,
 * splits stdout into lines, keeps a stderr tail, tees redacted output into the run's
 * logs directory and exposes everything as a RunHandle.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { AsyncQueue } from '../../util/async-queue.js';
import { killProcessTree, TailBuffer } from '../../util/process.js';
import { redactText } from '../../util/redact.js';
import type { AgentEvent, RunHandle, RunResult } from './types.js';

/** Env keys never passed to agent processes. */
const STRIPPED_ENV = ['NOCOPROJECT_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/**
 * The daemon's env minus secrets, plus `extra`. `PWD` is reset to the child's cwd: some tools
 * (OpenCode) take their project directory from `PWD`, which would otherwise still point at the
 * daemon's own working directory.
 */
export function buildChildEnv(extra: Record<string, string>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];
  return { ...env, ...extra, PWD: cwd };
}

export interface LineControl {
  emit(event: AgentEvent): void;
  readonly stdin: Writable | null;
  kill(): Promise<void>;
}

export interface FinishInfo {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
  readonly spawnError?: NodeJS.ErrnoException;
  readonly killed: boolean;
}

export interface LineProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly logsDir?: string;
  onSpawn?(child: ChildProcess, ctl: LineControl): void;
  onStdoutLine(line: string, ctl: LineControl): void;
  onStderr?(chunk: string, ctl: LineControl): void;
  finish(info: FinishInfo): RunResult;
}

function openLog(dir: string | undefined, name: string): WriteStream | null {
  if (!dir) return null;
  try {
    return createWriteStream(join(dir, name), { flags: 'a', mode: 0o600 });
  } catch {
    return null;
  }
}

export function launchLineProcess(opts: LineProcessOptions): RunHandle {
  const queue = new AsyncQueue<AgentEvent>();
  const stderrTail = new TailBuffer(16_384);
  const stdoutLog = openLog(opts.logsDir, 'agent.stdout.log');
  const stderrLog = openLog(opts.logsDir, 'agent.stderr.log');
  let killed = false;
  let spawnError: NodeJS.ErrnoException | undefined;

  const child = spawn(opts.command, [...opts.args], {
    cwd: opts.cwd,
    env: buildChildEnv(opts.env, opts.cwd),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  const kill = async (): Promise<void> => {
    killed = true;
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await killProcessTree(child);
  };
  const ctl: LineControl = { emit: (e) => queue.push(e), stdin: child.stdin, kill };
  child.stdin?.on('error', () => undefined);

  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutLog?.write(redactText(chunk));
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) opts.onStdoutLine(line, ctl);
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrLog?.write(redactText(chunk));
    stderrTail.append(chunk);
    opts.onStderr?.(chunk, ctl);
  });

  const result = new Promise<RunResult>((resolve) => {
    let settled = false;
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      const rest = buffer.trim();
      buffer = '';
      if (rest) opts.onStdoutLine(rest, ctl);
      stdoutLog?.end();
      stderrLog?.end();
      const finished = opts.finish({ exitCode, signal, stderrTail: stderrTail.toString(), spawnError, killed });
      queue.close();
      resolve(finished);
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
      if (child.pid === undefined) settle(null, null);
    });
    child.on('close', (code, signal) => settle(code, signal));
  });

  if (child.pid !== undefined) opts.onSpawn?.(child, ctl);
  return { events: queue, kill, result };
}
