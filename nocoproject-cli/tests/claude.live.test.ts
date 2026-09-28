/**
 * Opt-in live test against the real Claude Code CLI (costs provider tokens):
 *   NOCOPROJECT_LIVE_CLAUDE=1 [NOCOPROJECT_LIVE_CLAUDE_MODEL=<model>] pnpm vitest run tests/claude.live.test.ts
 *
 * The daemon claims a run from the mock server with an env var and a skill attached; `claude -p`
 * runs in the prepared workdir with CLAUDE.md and `.claude/skills/<slug>/`, and must post its reply
 * with the real `nocoproject` CLI (run-token mode).
 *
 * Skipped (with the reason printed) when `claude` is not installed (not on PATH, not in
 * ~/.claude/local or ~/.local/bin, and NOCOPROJECT_CLAUDE_PATH unset) or when the opt-in variable is
 * missing. Without the binary, Claude Code coverage comes from the stream-json fixtures in
 * tests/fixtures/claude/ (tests/adapters.test.ts).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/daemon/adapters/claude.js';
import { startDaemon, waitFor, type Harness } from './helpers/daemon-harness.js';
import { MockServer } from './helpers/mock-server.js';

const LIVE = Boolean(process.env.NOCOPROJECT_LIVE_CLAUDE);
const MODEL = process.env.NOCOPROJECT_LIVE_CLAUDE_MODEL;
const detected = await new ClaudeAdapter().detect();

const skipReason = !detected
  ? '`claude` (Claude Code) is not installed on this machine; the Claude adapter is covered by fixture tests only'
  : !LIVE
    ? `found claude ${detected.version}; set NOCOPROJECT_LIVE_CLAUDE=1 to run the live test (costs tokens)`
    : null;

if (skipReason) {
  console.warn(`[claude.live.test] skipped: ${skipReason}`);
  describe('live Claude Code loop', () => {
    it.skip(`skipped: ${skipReason}`, () => undefined);
  });
} else {
  describe('live Claude Code loop', () => {
    let mock: MockServer | undefined;
    let harness: Harness | undefined;
    afterEach(async () => {
      await harness?.daemon.stop(5000);
      await mock?.stop();
    });

    it('runs a real Claude Code agent end to end with a native skill', { timeout: 360_000 }, async () => {
      mock = new MockServer();
      await mock.start();
      harness = await startDaemon(mock, { provider: 'claude', idleWatchdogMs: 300_000 });
      mock.addIssue({ id: 'i1', identifier: 'NP-1', title: 'Say hello', description: 'Post a one-sentence friendly greeting as a comment. No code changes are needed.' });
      const skills = [{ id: 's1', slug: 'greeting', name: 'Greeting', description: 'How to greet the team', content: '# Greeting\n\nKeep greetings to one sentence.', files: [] }];
      const runId = mock.enqueue('i1', { provider: 'claude', triggerComment: 'Please greet the team in one sentence.', agentExtras: { skills, env: { LIVE_TEST_VALUE: 'live-test-secret-123' } } });
      const queued = mock.queue.find((q) => q.run.id === runId);
      if (queued && MODEL) (queued.agent as { model: string | null }).model = MODEL;
      const runs = mock.runs;
      await waitFor(() => ['completed', 'failed'].includes(runs.get(runId)?.status ?? '') && runs.get(runId), 340_000, 'claude run');
      const result = mock.callsTo(new RegExp(`runs/${runId}/(complete|fail)`))[0];
      console.log('outcome', result?.path, JSON.stringify(result?.body).slice(0, 800));
      expect(runs.get(runId)?.status).toBe('completed');
      expect(result?.body.usage).toMatchObject({ provider: 'claude' });
      const workDir = mock.callsTo(new RegExp(`runs/${runId}/start`))[0]?.body.workDir as string;
      expect(existsSync(join(workDir, '.claude', 'skills', 'greeting', 'SKILL.md'))).toBe(true);
      expect((mock.comments.get('i1') ?? []).some((c) => c.authorType === 'agent')).toBe(true);
    });
  });
}
