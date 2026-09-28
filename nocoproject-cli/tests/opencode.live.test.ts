/**
 * Opt-in live test against the real OpenCode CLI (costs a few provider tokens):
 *   NOCOPROJECT_LIVE_OPENCODE=1 [NOCOPROJECT_LIVE_OPENCODE_MODEL=deepseek/deepseek-flash] pnpm vitest run tests/opencode.live.test.ts
 * The daemon claims a run from the mock server, OpenCode runs in the prepared workdir and must
 * post its reply with the real `nocoproject` CLI (run-token mode) and move the issue to in_review.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, waitFor, type Harness } from './helpers/daemon-harness.js';
import { MockServer } from './helpers/mock-server.js';

const LIVE = Boolean(process.env.NOCOPROJECT_LIVE_OPENCODE);
const MODEL = process.env.NOCOPROJECT_LIVE_OPENCODE_MODEL ?? 'deepseek/deepseek-flash';

describe.skipIf(!LIVE)('live OpenCode loop', () => {
  let mock: MockServer | undefined;
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.daemon.stop(5000);
    await mock?.stop();
  });

  it('runs a real OpenCode agent end to end', { timeout: 300_000 }, async () => {
    mock = new MockServer();
    await mock.start();
    harness = await startDaemon(mock, { provider: 'opencode', idleWatchdogMs: 240_000 });
    mock.addIssue({ id: 'i1', identifier: 'NP-1', title: 'Say hello', description: 'Post a one-sentence friendly greeting as a comment. No code changes are needed.' });
    const runId = mock.enqueue('i1', { provider: 'opencode', triggerComment: 'Please greet the team in one sentence.' });
    const run = mock.runs;
    // Pin the model for the claimed run.
    const queued = mock.queue.find((q) => q.run.id === runId);
    if (queued) (queued.agent as { model: string | null }).model = MODEL;
    await waitFor(() => ['completed', 'failed'].includes(run.get(runId)?.status ?? '') && run.get(runId), 280_000, 'opencode run');
    const result = mock.callsTo(new RegExp(`runs/${runId}/(complete|fail)`))[0];
    const events = run.get(runId)?.events ?? [];
    console.log('outcome', result?.path, JSON.stringify(result?.body).slice(0, 800));
    console.log('event types', events.map((e) => `${e.type}${e.tool ? `:${e.tool}` : ''}`).join(' '));
    console.log('comments', JSON.stringify(mock.comments.get('i1')));
    expect(run.get(runId)?.status).toBe('completed');
    expect(result?.body.providerSessionId).toMatch(/^ses_/);
    expect(result?.body.usage).toMatchObject({ provider: 'opencode', model: MODEL });
    expect(events.some((e) => e.type === 'toolUse')).toBe(true);
    expect((mock.comments.get('i1') ?? []).some((c) => c.authorType === 'agent')).toBe(true);
    // A pure "answer" turn may legitimately leave the status alone (brief, Workflow step 6).
    expect(['todo', 'in_progress', 'in_review']).toContain(mock.issues.get('i1')?.statusKey);
    const commands = events.filter((e) => e.type === 'toolUse').map((e) => (e.input as { command?: string }).command).filter(Boolean);
    console.log('commands', JSON.stringify(commands));
    expect(commands.some((c) => /nocoproject issue comment add/.test(c ?? ''))).toBe(true);
  });
});
