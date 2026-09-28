import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, claudeUserMessage, newClaudeState, parseClaudeLine } from '../src/daemon/adapters/claude.js';
import { newEchoState } from './helpers/echo-state.js';
import { parseEchoLine } from '../src/daemon/adapters/echo.js';
import { buildOpenCodeArgs, fatalStderrLine, newOpenCodeState, openCodeUsage, parseOpenCodeLine } from '../src/daemon/adapters/opencode.js';
import type { AgentEvent } from '../src/daemon/adapters/types.js';

const fixture = (...p: string[]) => readFileSync(join(__dirname, 'fixtures', ...p), 'utf8').split('\n').filter(Boolean);
const AT = '2026-01-01T00:00:00.000Z';

describe('claude stream-json parser', () => {
  it('parses text, thinking, tool use, tool results, session id and usage', () => {
    const state = newClaudeState();
    const events: AgentEvent[] = [];
    let done = false;
    for (const line of fixture('claude', 'success.ndjson')) {
      const out = parseClaudeLine(line, state, AT);
      events.push(...out.events);
      done ||= Boolean(out.done);
    }
    expect(done).toBe(true);
    expect(state.sessionId).toBe('5d2f7c1e-8b3a-4c6d-9e0f-1a2b3c4d5e6f');
    expect(state.isError).toBe(false);
    expect(state.usage).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 15,
      outputTokens: 642,
      cacheReadTokens: 65040,
      cacheWriteTokens: 5920,
    });
    expect(state.resultText).toBe('I fixed the redirect and posted a summary on NP-12.');
    expect(events.map((e) => e.type)).toEqual(['status', 'thinking', 'toolUse', 'toolResult', 'toolUse', 'toolResult', 'toolUse', 'toolResult', 'text']);
    expect(events[1]).toMatchObject({ type: 'thinking', content: 'I should read the issue before doing anything else.' });
    expect(events[2]).toMatchObject({ type: 'toolUse', tool: 'Bash', callId: 'toolu_01ABC', input: { command: 'nocoproject issue get NP-12 --json' } });
    expect(events[3]).toMatchObject({ type: 'toolResult', callId: 'toolu_01ABC' });
    expect(events[3]?.output).toContain('"identifier": "NP-12"');
    expect(events[5]?.output).toContain("return redirect('/home');");
    expect(events[7]?.output).toBe('[error] cat: missing.txt: No such file or directory');
    expect(events[8]).toMatchObject({ type: 'text', content: 'I fixed the redirect and posted a summary on NP-12.' });
    expect(state.visible).toBe(8);
  });

  it('surfaces synthetic auth errors', () => {
    const state = newClaudeState();
    const events = fixture('claude', 'auth-error.ndjson').flatMap((l) => parseClaudeLine(l, state, AT).events);
    expect(state.isError).toBe(true);
    expect(state.errors.join('\n')).toContain('Invalid API key');
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('flags context overflow results', () => {
    const state = newClaudeState();
    fixture('claude', 'context-overflow.ndjson').forEach((l) => parseClaudeLine(l, state, AT));
    expect(state.isError).toBe(true);
    expect(state.errors.join('\n')).toContain('Prompt is too long');
  });

  it('returns control requests for auto-approval', () => {
    const state = newClaudeState();
    const outs = fixture('claude', 'control-request.ndjson').map((l) => parseClaudeLine(l, state, AT));
    expect(outs[1]?.controlRequest).toEqual({ requestId: 'req_1_a1b2c3', input: { command: 'ls' } });
  });

  it('ignores garbage lines', () => {
    expect(parseClaudeLine('not json', newClaudeState()).events).toEqual([]);
  });

  it('builds launch args and the stdin user message', () => {
    expect(buildClaudeArgs({ model: 'opus', resumeSessionId: 'abc' })).toEqual([
      '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions', '--model', 'opus', '--resume', 'abc',
    ]);
    expect(JSON.parse(claudeUserMessage('hi'))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  });
});

describe('opencode json parser', () => {
  it('parses a real OpenCode 1.18.32 capture', () => {
    const state = newOpenCodeState();
    const events = fixture('opencode', 'real-1.18.32-tool-and-text.ndjson').flatMap((l) => parseOpenCodeLine(l, state));
    expect(state.sessionId).toBe('ses_f1f102ddeffeWU2fYjN0bi7SZn');
    expect(events.map((e) => e.type)).toEqual(['toolUse', 'toolResult', 'text']);
    expect(events[0]).toMatchObject({ tool: 'bash', input: { command: 'echo hello-np' } });
    expect(events[1]).toMatchObject({ output: 'hello-np\n' });
    expect(events[2]).toMatchObject({ content: 'done' });
    expect(openCodeUsage(state, 'deepseek/deepseek-flash')).toEqual({
      provider: 'opencode', model: 'deepseek/deepseek-flash', inputTokens: 12710, outputTokens: 42, cacheReadTokens: 15616, cacheWriteTokens: 0,
    });
  });

  it('parses reasoning, tool errors and error events', () => {
    const state = newOpenCodeState();
    const events = [
      ...fixture('opencode', 'constructed-reasoning-tool-error.ndjson'),
      ...fixture('opencode', 'real-1.18.32-error.ndjson'),
    ].flatMap((l) => parseOpenCodeLine(l, state));
    expect(events.map((e) => e.type)).toEqual(['thinking', 'toolUse', 'toolResult', 'error']);
    expect(events[2]?.output).toBe('[error] File not found: /nope.txt');
    expect(state.errors).toEqual(['Unexpected server error. Check server logs for details.']);
    expect(state.tokens).toMatchObject({ input: 1000, output: 75, cacheRead: 15, cacheWrite: 10 });
  });

  it('detects fatal provider errors in --print-logs stderr', () => {
    const log = readFileSync(join(__dirname, 'fixtures', 'opencode', 'stderr-usage-limit.log'), 'utf8');
    expect(fatalStderrLine(log)).toBe('AI_APICallError: Go usage limit exceeded');
    expect(fatalStderrLine('level=WARN message="duplicate skill name"')).toBeUndefined();
  });

  it('builds launch args', () => {
    expect(buildOpenCodeArgs({ prompt: 'do it', model: 'deepseek/deepseek-flash', resumeSessionId: 'ses_1', workDir: '/w' })).toEqual([
      'run', '--format', 'json', '--auto', '--thinking', '--print-logs', '--log-level', 'WARN', '--dir', '/w', '--session', 'ses_1', '--model', 'deepseek/deepseek-flash', 'do it',
    ]);
  });
});

describe('echo parser', () => {
  it('maps echo events', () => {
    const state = newEchoState();
    const lines = [
      '{"type":"text","text":"hi"}',
      '{"type":"tool_use","id":"call_1","name":"shell","input":{"command":"nocoproject issue get NP-1 --json"}}',
      '{"type":"tool_result","id":"call_1","output":"{}","is_error":false}',
      '{"type":"result","session_id":"echo-1","text":"done","usage":{"inputTokens":3,"outputTokens":4}}',
    ];
    const events = lines.flatMap((l) => parseEchoLine(l, state, AT));
    expect(events.map((e) => e.type)).toEqual(['text', 'toolUse', 'toolResult']);
    expect(state).toMatchObject({ sessionId: 'echo-1', summary: 'done', sawResult: true, visible: 3 });
    expect(state.usage).toMatchObject({ provider: 'echo', inputTokens: 3, outputTokens: 4 });
  });
});
