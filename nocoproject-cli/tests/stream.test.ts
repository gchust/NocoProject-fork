import { describe, expect, it } from 'vitest';
import { HttpError, NetworkError } from '../src/api/client.js';
import type { AgentEvent } from '../src/daemon/adapters/types.js';
import { EventStreamer, MAX_CONTENT_BYTES, toWireEvent, truncateUtf8 } from '../src/daemon/stream.js';
import type { RunEventInput } from '../src/protocol.js';
import { forgetSecret, redactKnownSecrets, redactText, redactValue, registerSecret } from '../src/util/redact.js';

const AT = '2026-01-01T00:00:00.000Z';
const ev = (type: AgentEvent['type'], content?: string): AgentEvent => ({ type, content, at: AT });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Sink {
  batches: RunEventInput[][] = [];
  failNext: unknown[] = [];
  async events(_runId: string, body: { events: readonly RunEventInput[] }): Promise<void> {
    const err = this.failNext.shift();
    if (err) throw err;
    this.batches.push([...body.events]);
  }
  get all(): RunEventInput[] {
    return this.batches.flat();
  }
}

describe('redaction', () => {
  it.each([
    ['aws', 'key AKIAABCDEFGHIJKLMNOP here', 'key [REDACTED AWS KEY] here'],
    ['github', `token ghp_${'a'.repeat(36)}`, 'token [REDACTED GITHUB TOKEN]'],
    ['github pat', `github_pat_${'B'.repeat(30)}`, '[REDACTED GITHUB TOKEN]'],
    ['sk key', 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'ANTHROPIC_API_KEY=[REDACTED API KEY]'],
    ['run token', `NOCOPROJECT_TOKEN=npr_${'0f'.repeat(20)}`, 'NOCOPROJECT_TOKEN=[REDACTED RUN TOKEN]'],
    ['bearer', 'Authorization: Bearer abc.def-ghi', 'Authorization: Bearer [REDACTED]'],
    ['x-api-key', '{"x-api-key": "abcdef123456"}', '{"x-api-key": "[REDACTED]"}'],
    ['url credentials', 'fatal: https://x-access-token:s3cret@github.com/o/r.git', 'fatal: https://[REDACTED]@github.com/o/r.git'],
  ])('%s', (_n, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('redacts PEM blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----';
    expect(redactText(`before\n${pem}\nafter`)).toBe('before\n[REDACTED PRIVATE KEY]\nafter');
  });

  it('honours minLength and reference-counts registrations', () => {
    registerSecret('abc12');
    registerSecret('abc12', { minLength: 6 });
    expect(redactText('v=abc12')).toBe('v=abc12');
    registerSecret('env-val', { minLength: 6 });
    registerSecret('env-val', { minLength: 6 });
    forgetSecret('env-val');
    expect(redactText('v=env-val')).toBe('v=[REDACTED]');
    forgetSecret('env-val');
    expect(redactText('v=env-val')).toBe('v=env-val');
  });

  it('masks only registered secrets with redactKnownSecrets', () => {
    registerSecret('brief-secret-1', { minLength: 6 });
    expect(redactKnownSecrets('a brief-secret-1 https://u:p@host/x')).toBe('a [REDACTED] https://u:p@host/x');
    forgetSecret('brief-secret-1');
  });

  it('redacts registered secrets and nested values', () => {
    registerSecret('my-daemon-api-key-xyz');
    expect(redactText('key=my-daemon-api-key-xyz')).toBe('key=[REDACTED]');
    expect(redactValue({ a: ['Bearer tok123'], b: { c: 'AKIAABCDEFGHIJKLMNOP' }, n: 1 })).toEqual({
      a: ['Bearer [REDACTED]'],
      b: { c: '[REDACTED AWS KEY]' },
      n: 1,
    });
  });
});

describe('truncation', () => {
  it('truncates by bytes without splitting characters', () => {
    const big = '中'.repeat(MAX_CONTENT_BYTES);
    const t = truncateUtf8(big);
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.text)).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    expect(t.text.endsWith('中')).toBe(true);
  });

  it('marks truncated wire events and redacts tool input', () => {
    const wire = toWireEvent({ type: 'toolUse', tool: 'Bash', input: { command: 'echo sk-abcdefghijklmnopqrstuvwxyz' }, content: 'x'.repeat(70_000), at: AT }, 7);
    expect(wire).toMatchObject({ seq: 7, type: 'toolUse', tool: 'Bash', truncated: true, input: { command: 'echo [REDACTED API KEY]' } });
    expect(wire.content?.length).toBe(MAX_CONTENT_BYTES);
  });
});

describe('EventStreamer', () => {
  it('flushes the first visible event immediately and batches the rest', async () => {
    const sink = new Sink();
    const s = new EventStreamer(sink, 'r1', { flushIntervalMs: 50 });
    s.push(ev('status', 'starting'));
    await wait(10);
    expect(sink.batches.length).toBe(0);
    s.push(ev('text', 'hello'));
    await wait(10);
    expect(sink.batches.length).toBe(1);
    expect(sink.batches[0]?.map((e) => e.seq)).toEqual([1, 2]);
    s.push(ev('text', 'a'));
    s.push(ev('text', 'b'));
    await wait(10);
    expect(sink.batches.length).toBe(1);
    await wait(80);
    expect(sink.batches.length).toBe(2);
    expect(sink.batches[1]?.map((e) => e.seq)).toEqual([3, 4]);
    await s.close();
  });

  it('caps batches at 200 events and keeps seq monotonic', async () => {
    const sink = new Sink();
    const s = new EventStreamer(sink, 'r1', { flushIntervalMs: 1000 });
    for (let i = 0; i < 450; i++) s.push(ev('status', `e${i}`));
    await s.close();
    expect(sink.batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(sink.all.map((e) => e.seq)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
    expect(s.lastSeq).toBe(450);
  });

  it('retries transient failures and keeps order', async () => {
    const sink = new Sink();
    sink.failNext = [new NetworkError('ECONNREFUSED', 'POST', '/x'), new HttpError(503, 'X', 'busy', 'POST', '/x')];
    const s = new EventStreamer(sink, 'r1', { flushIntervalMs: 10 });
    s.push(ev('text', 'one'));
    s.push(ev('text', 'two'));
    await s.close();
    expect(sink.all.map((e) => e.content)).toEqual(['one', 'two']);
  });

  it('drops a batch on a permanent 4xx', async () => {
    const sink = new Sink();
    sink.failNext = [new HttpError(400, 'BAD', 'nope', 'POST', '/x')];
    const s = new EventStreamer(sink, 'r1', { flushIntervalMs: 10 });
    s.push(ev('text', 'lost'));
    await s.close();
    s.push(ev('text', 'after close ignored'));
    expect(sink.all).toEqual([]);
  });

  it('redacts content before sending', async () => {
    const sink = new Sink();
    const s = new EventStreamer(sink, 'r1');
    s.push({ type: 'toolResult', output: `export NOCOPROJECT_TOKEN=npr_${'a1'.repeat(20)}`, at: AT });
    await s.close();
    expect(sink.all[0]?.output).toBe('export NOCOPROJECT_TOKEN=[REDACTED RUN TOKEN]');
  });
});
