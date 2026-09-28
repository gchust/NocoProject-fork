/**
 * Opt-in live test against the real Codex CLI (costs provider tokens):
 *   NOCOPROJECT_LIVE_CODEX=1 [NOCOPROJECT_LIVE_CODEX_MODEL=<model>] pnpm vitest run tests/codex.live.test.ts
 * The daemon claims a run from the mock server, `codex exec` runs in the prepared workdir with
 * AGENTS.md and must post its reply with the real `nocoproject` CLI (run-token mode).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, waitFor, type Harness } from './helpers/daemon-harness.js';
import { MockServer } from './helpers/mock-server.js';

const LIVE = Boolean(process.env.NOCOPROJECT_LIVE_CODEX);
const MODEL = process.env.NOCOPROJECT_LIVE_CODEX_MODEL;

describe.skipIf(!LIVE)('live Codex loop', () => {
  let mock: MockServer | undefined;
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.daemon.stop(5000);
    await mock?.stop();
  });

  it('runs a real Codex agent end to end', { timeout: 360_000 }, async () => {
    mock = new MockServer();
    await mock.start();
    harness = await startDaemon(mock, { provider: 'codex', idleWatchdogMs: 300_000 });
    mock.addIssue({ id: 'i1', identifier: 'NP-1', title: 'Say hello', description: 'Post a one-sentence friendly greeting as a comment. No code changes are needed.' });
    const runId = mock.enqueue('i1', { provider: 'codex', triggerComment: 'Please greet the team in one sentence.' });
    const queued = mock.queue.find((q) => q.run.id === runId);
    if (queued && MODEL) (queued.agent as { model: string | null }).model = MODEL;
    const runs = mock.runs;
    await waitFor(() => ['completed', 'failed'].includes(runs.get(runId)?.status ?? '') && runs.get(runId), 340_000, 'codex run');
    const result = mock.callsTo(new RegExp(`runs/${runId}/(complete|fail)`))[0];
    const events = runs.get(runId)?.events ?? [];
    console.log('outcome', result?.path, JSON.stringify(result?.body).slice(0, 800));
    console.log('event types', events.map((e) => `${e.type}${e.tool ? `:${e.tool}` : ''}`).join(' '));
    console.log('comments', JSON.stringify(mock.comments.get('i1')));
    expect(runs.get(runId)?.status).toBe('completed');
    expect(result?.body.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result?.body.usage).toMatchObject({ provider: 'codex' });
    const commands = events.filter((e) => e.type === 'toolUse').map((e) => (e.input as { command?: string }).command ?? '');
    console.log('commands', JSON.stringify(commands));
    expect(commands.some((c) => /nocoproject issue comment add/.test(c))).toBe(true);
    expect((mock.comments.get('i1') ?? []).some((c) => c.authorType === 'agent')).toBe(true);
  });
});
