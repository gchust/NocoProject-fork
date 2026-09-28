import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, waitFor, type Harness } from './helpers/daemon-harness.js';
import { API_KEY, MockServer } from './helpers/mock-server.js';

let mock: MockServer | undefined;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.daemon.stop(5000);
  await mock?.stop();
  harness = undefined;
  mock = undefined;
});

async function setup(opts: Parameters<typeof startDaemon>[1] = {}, mockOpts = {}) {
  mock = new MockServer(mockOpts);
  await mock.start();
  harness = await startDaemon(mock, opts);
  return { mock, harness };
}

const runStatus = (m: MockServer, id: string) => m.runs.get(id)?.status;

describe('daemon e2e with the echo adapter', () => {
  it('claims on a WS wakeup, runs the echo agent and reports completion', async () => {
    const { mock, harness } = await setup();
    await waitFor(() => mock.subscribers === 1, 5000, 'ws subscription');
    mock.addIssue({ id: 'i1', identifier: 'NP-1', title: 'Echo test' });
    const enqueuedAt = Date.now();
    const runId = mock.enqueue('i1', { triggerComment: '@Echo please say hello' });
    await waitFor(() => mock.callsTo(/runs\/claim/).find((c) => c.body.slots.length > 0 && mock.runs.has(runId)), 5000, 'claim');
    const claimLatency = Date.now() - enqueuedAt;
    expect(claimLatency).toBeLessThan(3000);
    await waitFor(() => runStatus(mock, runId) === 'completed', 20_000, 'completion');

    const register = mock.callsTo(/daemon\/register/)[0];
    expect(register?.body).toMatchObject({ daemonId: 'daemon-test-1', deviceName: 'test-box', protocolVersion: 1, runtimes: [{ provider: 'echo', capabilities: { resume: true, steering: false } }] });
    expect(register?.auth).toBe(API_KEY);

    const start = mock.callsTo(new RegExp(`runs/${runId}/start`))[0];
    expect(start?.body.workDir).toMatch(/NP-1-101\/workdir$|NP-1-\d+\/workdir$/);
    const workDir = start?.body.workDir as string;
    expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf8')).toContain('<!-- BEGIN NOCOPROJECT-RUNTIME');
    expect(existsSync(join(workDir, 'reply.md'))).toBe(true);

    const events = mock.runs.get(runId)?.events ?? [];
    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['status', 'text', 'toolUse', 'toolResult']));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.find((e) => e.type === 'toolUse')?.input.command).toMatch(/^nocoproject issue get NP-1 --json$/);

    const complete = mock.callsTo(new RegExp(`runs/${runId}/complete`))[0];
    expect(complete?.body).toMatchObject({
      workDir,
      providerSessionId: `echo-${runId}`,
      summary: 'Echo agent delivered a reply on NP-1.',
      usage: { provider: 'echo', model: 'echo' },
    });

    const comments = mock.comments.get('i1') ?? [];
    const root = comments[0];
    const reply = comments.find((c) => c.authorType === 'agent');
    expect(reply?.content).toMatch(/^Echo agent report: handled NP-1 "Echo test"/);
    expect(reply?.content).toContain('You said: @Echo please say hello');
    expect(reply?.parentId).toBe(root?.id);
    expect(mock.issues.get('i1')?.statusKey).toBe('in_review');

    const agentCalls = mock.callsTo(/\/np\/agent\//);
    expect(agentCalls.length).toBeGreaterThanOrEqual(4);
    expect(agentCalls.every((c) => c.auth?.startsWith('Bearer npr_'))).toBe(true);
    const token = mock.runs.get(runId)?.claimed.token as string;
    expect(harness.logs.join('\n')).not.toContain(token);
    expect(harness.logs.join('\n')).not.toContain(API_KEY);
    expect(mock.callsTo(/runs\/.*\/lease/).length).toBeGreaterThanOrEqual(0);
  });

  it('reuses the prior workDir and resumes the session when not fresh', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i2', identifier: 'NP-2' });
    const first = mock.enqueue('i2');
    await waitFor(() => runStatus(mock, first) === 'completed', 20_000, 'first run');
    const workDir = mock.callsTo(new RegExp(`runs/${first}/start`))[0]?.body.workDir as string;
    mock.issues.set('i2', { ...(mock.issues.get('i2') as any), statusKey: 'todo' });
    const second = mock.enqueue('i2', { session: { providerSessionId: `echo-${first}`, workDir, fresh: false } });
    await waitFor(() => runStatus(mock, second) === 'completed', 20_000, 'second run');
    const start2 = mock.callsTo(new RegExp(`runs/${second}/start`))[0];
    expect(start2?.body).toEqual({ acceptsInput: true, providerSessionId: `echo-${first}`, workDir });
  });

  it('classifies agent failures', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i3', identifier: 'NP-3', title: 'Boom [echo:fail=API Error: 429 Too Many Requests]' });
    const runId = mock.enqueue('i3');
    await waitFor(() => runStatus(mock, runId) === 'failed', 20_000, 'failure');
    const fail = mock.callsTo(new RegExp(`runs/${runId}/fail`))[0];
    expect(fail?.body).toMatchObject({ reason: 'agentError.providerRateLimit', sessionPoisoned: false });
    expect(fail?.body.detail).toContain('429');
  });

  it('kills the agent on a WS cancelRequested and acks', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i4', identifier: 'NP-4', title: 'Slow [echo:sleep=30000]' });
    const runId = mock.enqueue('i4');
    await waitFor(() => (mock.runs.get(runId)?.events ?? []).some((e) => /Sleeping/.test(e.content ?? '')), 15_000, 'agent sleeping');
    const t0 = Date.now();
    mock.requestCancel(runId);
    await waitFor(() => runStatus(mock, runId) === 'cancelled', 15_000, 'cancel ack');
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(mock.callsTo(new RegExp(`runs/${runId}/cancel-ack`)).length).toBe(1);
    expect(mock.callsTo(new RegExp(`runs/${runId}/(complete|fail)`)).length).toBe(0);
  });

  it('notices cancellation by polling run status', async () => {
    const { mock } = await setup({ intervals: { cancelPollMs: 150 } });
    mock.addIssue({ id: 'i5', identifier: 'NP-5', title: 'Slow [echo:sleep=30000]' });
    const runId = mock.enqueue('i5');
    await waitFor(() => runStatus(mock, runId) === 'running', 15_000, 'running');
    const run = mock.runs.get(runId);
    if (run) run.cancelRequested = true;
    await waitFor(() => runStatus(mock, runId) === 'cancelled', 15_000, 'cancelled via poll');
  });

  it('fires the idle watchdog', async () => {
    const { mock } = await setup({ idleWatchdogMs: 1500 });
    mock.addIssue({ id: 'i6', identifier: 'NP-6', title: 'Hang [echo:sleep=30000]' });
    const runId = mock.enqueue('i6');
    await waitFor(() => runStatus(mock, runId) === 'failed', 20_000, 'watchdog failure');
    expect(mock.callsTo(new RegExp(`runs/${runId}/fail`))[0]?.body.reason).toBe('agentError.agentTimeout');
  });

  it('falls back to polling when the socket refuses x-api-key auth', async () => {
    const { mock, harness } = await setup({ pollIntervalMs: 300 }, { wsAuth: false });
    await waitFor(() => harness.daemon.snapshot().socket === 'authUnsupported', 5000, 'auth unsupported');
    mock.addIssue({ id: 'i7', identifier: 'NP-7' });
    const runId = mock.enqueue('i7');
    await waitFor(() => runStatus(mock, runId) === 'completed', 20_000, 'completion via poll');
  });

  it('reports runs as runtimeRecovery on shutdown and deregisters', async () => {
    const { mock, harness } = await setup();
    mock.addIssue({ id: 'i8', identifier: 'NP-8', title: 'Slow [echo:sleep=30000]' });
    const runId = mock.enqueue('i8');
    await waitFor(() => runStatus(mock, runId) === 'running', 15_000, 'running');
    await harness.daemon.stop(10_000);
    expect(mock.callsTo(new RegExp(`runs/${runId}/fail`))[0]?.body.reason).toBe('runtimeRecovery');
    expect(mock.callsTo(/daemon\/deregister/).length).toBe(1);
  });

  it('stops claiming on protocol mismatch', async () => {
    const { mock, harness } = await setup({}, { protocolMismatch: true });
    expect(harness.daemon.snapshot().protocolMismatch).toBe(true);
    expect(mock.callsTo(/runs\/claim/).length).toBe(0);
    expect(harness.logs.join('\n')).toContain('PROTOCOL MISMATCH');
  });

  it('sends heartbeats', async () => {
    const { mock } = await setup();
    await waitFor(() => mock.callsTo(/daemon\/heartbeat/).length >= 2, 5000, 'heartbeats');
    expect(mock.callsTo(/daemon\/heartbeat/)[0]?.body).toEqual({ daemonId: 'daemon-test-1', runtimeIds: ['rt-echo'] });
  });
});
