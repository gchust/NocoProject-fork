/**
 * Iteration 4 §C: the agent's `reasoningEffort` reaches each tool as its own flag. The adapters are
 * started against a fake executable that records the argv it was spawned with.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/daemon/adapters/claude.js';
import { CodexAdapter } from '../src/daemon/adapters/codex.js';
import { OpenCodeAdapter } from '../src/daemon/adapters/opencode.js';
import type { AgentAdapter, RunSpec } from '../src/daemon/adapters/types.js';
import type { ReasoningEffort } from '../src/protocol.js';
import { reasoningEffortOf } from '../src/run-context.js';
import { iter4Run } from './helpers/fixtures.js';

/** A fake tool: answers --version / --help, otherwise writes its argv (one per line) to $ARGV_FILE. */
function fakeTool(help: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ncp-fake-'));
  const path = join(dir, 'tool');
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi\nif [ "$1" = "--help" ]; then printf '%s\\n' "${help}"; exit 0; fi\nprintf '%s\\n' "$@" > "$ARGV_FILE"\nexit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function spawnedArgv(adapter: AgentAdapter, effort: ReasoningEffort | undefined): Promise<string[]> {
  expect(await adapter.detect()).not.toBeNull();
  const workDir = mkdtempSync(join(tmpdir(), 'ncp-effort-'));
  const argvFile = join(workDir, 'argv.txt');
  const spec: RunSpec = { runId: 'r1', workDir, prompt: 'hello', env: { ARGV_FILE: argvFile }, model: 'm1', reasoningEffort: effort };
  const handle = await adapter.start(spec, { log: () => undefined });
  for await (const _ of handle.events) void _;
  await handle.result;
  expect(existsSync(argvFile)).toBe(true);
  return readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
}

const after = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

describe('reasoning effort → tool flags', () => {
  it('opencode gets --variant <effort>', async () => {
    const argv = await spawnedArgv(new OpenCodeAdapter(fakeTool('')), 'high');
    expect(after(argv, '--variant')).toBe('high');
    expect(argv.at(-1)).toBe('hello');
    expect(await spawnedArgv(new OpenCodeAdapter(fakeTool('')), undefined)).not.toContain('--variant');
  });

  it('codex gets -c model_reasoning_effort="<effort>" for new and resumed sessions', async () => {
    const argv = await spawnedArgv(new CodexAdapter(fakeTool('')), 'max');
    expect(after(argv, '-c')).toBe('model_reasoning_effort="max"');
    expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(await spawnedArgv(new CodexAdapter(fakeTool('')), undefined)).not.toContain('-c');
  });

  it('claude gets --effort <level> when its --help lists the flag', async () => {
    const help = '  --effort <level>   Effort level for the current session (low, medium, high, xhigh, max)';
    expect(after(await spawnedArgv(new ClaudeAdapter(fakeTool(help)), 'medium'), '--effort')).toBe('medium');
    expect(after(await spawnedArgv(new ClaudeAdapter(fakeTool(help)), 'minimal'), '--effort')).toBe('low');
    expect(await spawnedArgv(new ClaudeAdapter(fakeTool(help)), undefined)).not.toContain('--effort');
  });

  it('claude ignores the effort when its --help has no --effort', async () => {
    const argv = await spawnedArgv(new ClaudeAdapter(fakeTool('  --model <model>')), 'high');
    expect(argv).not.toContain('--effort');
    expect(after(argv, '--model')).toBe('m1');
  });

  it('only known levels from the claim payload are passed on', () => {
    expect(reasoningEffortOf(iter4Run({}, { reasoningEffort: 'high' }))).toBe('high');
    expect(reasoningEffortOf(iter4Run({}, { reasoningEffort: null }))).toBeUndefined();
    expect(reasoningEffortOf(iter4Run({}, { reasoningEffort: 'ultra; rm -rf' as any }))).toBeUndefined();
  });
});
