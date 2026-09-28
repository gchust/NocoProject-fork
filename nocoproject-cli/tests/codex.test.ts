import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCodexArgs,
  CodexAdapter,
  codexErrorText,
  codexStderrErrors,
  codexUsage,
  newCodexState,
  parseCodexLine,
} from '../src/daemon/adapters/codex.js';
import type { AgentEvent } from '../src/daemon/adapters/types.js';
import { classifyFailure } from '../src/daemon/classify.js';

const FIXTURES = join(__dirname, 'fixtures', 'codex');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const lines = (name: string) => fixture(name).split('\n').filter(Boolean);
const AT = '2026-01-01T00:00:00.000Z';

describe('codex exec --json parser (real codex-cli 0.154.0 captures)', () => {
  it('parses a plain reply: session id, text, usage', () => {
    const state = newCodexState();
    const events = lines('real-0.154-ok.jsonl').flatMap((l) => parseCodexLine(l, state, AT));
    expect(state.sessionId).toBe('01a0e125-a859-70f0-a2df-c4d8fb217d11');
    expect(events.map((e) => e.type)).toEqual(['status', 'text']);
    expect(events[1]).toMatchObject({ content: 'OK' });
    expect(state).toMatchObject({ turnCompleted: true, turnFailed: false, lastText: 'OK', visible: 1 });
    expect(codexUsage(state, undefined)).toEqual({ provider: 'codex', model: undefined, inputTokens: 16974, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('parses a resumed turn with a shell command', () => {
    const state = newCodexState();
    const events: AgentEvent[] = lines('real-0.154-resume-shell.jsonl').flatMap((l) => parseCodexLine(l, state, AT));
    expect(events.map((e) => e.type)).toEqual(['status', 'toolUse', 'toolResult', 'text']);
    expect(events[1]).toMatchObject({ tool: 'shell', callId: 'item_0', input: { command: "/bin/zsh -lc 'echo hello-np'" } });
    expect(events[2]).toMatchObject({ tool: 'shell', callId: 'item_0', output: 'hello-np\n' });
    expect(events[3]).toMatchObject({ content: 'done' });
    expect(codexUsage(state, 'gpt-x')).toEqual({ provider: 'codex', model: 'gpt-x', inputTokens: 63044 - 22272, outputTokens: 121, cacheReadTokens: 22272, cacheWriteTokens: 0 });
  });

  it('reports turn failures once and classifies model_not_found', () => {
    const state = newCodexState();
    const events = lines('real-0.154-model-not-found.jsonl').flatMap((l) => parseCodexLine(l, state, AT));
    expect(events.map((e) => e.type)).toEqual(['status', 'status', 'error']);
    expect(events[1]?.content).toMatch(/^Codex warning: Model metadata for `no-such-model-xyz` not found/);
    expect(state.turnFailed).toBe(true);
    expect(state.errors).toEqual(['model_not_found: unknown provider for model no-such-model-xyz']);
    expect(classifyFailure({ errorText: state.errors.join('\n'), exitCode: 1 })).toBe('agentError.modelUnavailable');
  });

  it('maps other item kinds and command failures', () => {
    const state = newCodexState();
    const raw = [
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Thinking about it' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'false', aggregated_output: 'boom', exit_code: 1, status: 'failed' } },
      { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'add' }], status: 'completed' } },
      { type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'gh', tool: 'search', arguments: { q: 'x' }, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'gh', tool: 'search', arguments: { q: 'x' }, error: { message: 'denied' }, status: 'failed' } },
      { type: 'item.completed', item: { id: 't1', type: 'todo_list', items: [{ text: 'read', completed: true }, { text: 'fix', completed: false }] } },
      { type: 'error', message: 'stream disconnected' },
    ];
    const events = raw.flatMap((r) => parseCodexLine(JSON.stringify(r), state, AT));
    expect(events.map((e) => `${e.type}:${e.tool ?? ''}`)).toEqual([
      'thinking:', 'toolUse:shell', 'toolResult:shell', 'toolUse:apply_patch', 'toolResult:apply_patch', 'toolUse:gh.search', 'toolResult:gh.search', 'status:', 'error:',
    ]);
    expect(events[2]?.output).toBe('[error] exit 1\nboom');
    expect(events[4]?.output).toBe('add a.ts');
    expect(events[6]?.output).toBe('[error] denied');
    expect(events[7]?.content).toBe('Plan:\n[x] read\n[ ] fix');
    expect(parseCodexLine('not json', state)).toEqual([]);
  });

  it('extracts readable error text', () => {
    expect(codexErrorText('{"error":{"code":"rate_limit_exceeded","message":"slow down"}}')).toBe('rate_limit_exceeded: slow down');
    expect(codexErrorText('plain')).toBe('plain');
  });

  it('ignores MCP / login noise on stderr', () => {
    expect(codexStderrErrors(fixture('real-0.154-stderr-noise.log'))).toBe('');
    expect(codexStderrErrors(fixture('real-0.154-resume-not-found.stderr.log'))).toContain('no rollout found for thread id');
  });

  it('builds exec and exec resume args', () => {
    expect(buildCodexArgs({ prompt: 'do it', workDir: '/w', model: 'gpt-5' })).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', '/w', '-m', 'gpt-5', 'do it',
    ]);
    expect(buildCodexArgs({ prompt: 'again', workDir: '/w', resumeSessionId: 'abc' })).toEqual([
      'exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'abc', 'again',
    ]);
  });
});

/** A fake `codex` that replays a fixture on stdout and a log on stderr. */
function fakeCodex(stdoutFixture: string | null, stderrFixture: string | null, exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'ncp-fake-codex-'));
  const bin = join(dir, 'codex');
  const out = stdoutFixture ? `cat ${JSON.stringify(join(FIXTURES, stdoutFixture))}` : 'true';
  const err = stderrFixture ? `cat ${JSON.stringify(join(FIXTURES, stderrFixture))} >&2` : 'true';
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'args'))}\n${out}\n${err}\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

async function drain(adapter: CodexAdapter, spec: { resumeSessionId?: string } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'ncp-codex-wd-'));
  const handle = await adapter.start({ runId: 'r1', workDir, prompt: 'Reply OK', env: {}, ...spec });
  const events: AgentEvent[] = [];
  for await (const e of handle.events) events.push(e);
  return { events, result: await handle.result };
}

describe('CodexAdapter process handling', () => {
  it('completes a run despite 401 noise on stderr', async () => {
    const { events, result } = await drain(new CodexAdapter(fakeCodex('real-0.154-ok.jsonl', 'real-0.154-stderr-noise.log', 0)));
    expect(events.map((e) => e.type)).toEqual(['status', 'text']);
    expect(result).toMatchObject({ exitCode: 0, sessionId: '01a0e125-a859-70f0-a2df-c4d8fb217d11', summary: 'OK', visibleEvents: 1, resumeRejected: false });
    expect(result.errorText).toBeUndefined();
    expect(result.usage).toMatchObject({ provider: 'codex', inputTokens: 16974 });
  });

  it('flags an unknown resume session so the runner retries fresh', async () => {
    const { result } = await drain(new CodexAdapter(fakeCodex(null, 'real-0.154-resume-not-found.stderr.log', 1)), { resumeSessionId: '00000000-0000-7000-8000-000000000000' });
    expect(result.resumeRejected).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(result.errorText).toContain('no rollout found');
  });

  it('reports turn failures with the JSON error, not stderr noise', async () => {
    const { result } = await drain(new CodexAdapter(fakeCodex('real-0.154-model-not-found.jsonl', 'real-0.154-stderr-noise.log', 1)));
    expect(result.errorText).toBe('model_not_found: unknown provider for model no-such-model-xyz');
    expect(classifyFailure({ errorText: result.errorText, exitCode: result.exitCode })).toBe('agentError.modelUnavailable');
  });
});
