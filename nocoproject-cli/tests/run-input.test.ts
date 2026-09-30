import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun, type RunnerApi } from '../src/daemon/runner.js';
import type { AgentAdapter, RunSpec } from '../src/daemon/adapters/types.js';
import type { ClaimedTriggerComment, DaemonCompleteRequest, DaemonRunStatusResponse } from '../src/protocol.js';
import { HttpError } from '../src/api/client.js';
import { silentLogger } from '../src/util/log.js';
import { claimedRun } from './helpers/fixtures.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const comment = (id: string): ClaimedTriggerComment => ({ id, content: `Please handle ${id}`, authorName: 'Alice', parentId: null, rootId: id });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'np-input-'));
  roots.push(root);
  const specs: RunSpec[] = [];
  let inputs: ClaimedTriggerComment[] = [];
  const state: DaemonRunStatusResponse = { status: 'running', cancelRequested: false };
  const api: RunnerApi = {
    lease: vi.fn(async () => ({})),
    start: vi.fn(async () => ({})),
    events: vi.fn(async () => ({})),
    status: vi.fn(async () => ({ ...state, inputs })),
    complete: vi.fn(async (_id: string, body: DaemonCompleteRequest) => {
      if (inputs.some((c) => !body.handledInputIds?.includes(c.id))) throw new HttpError(409, 'RUN_INPUT_PENDING', 'pending', 'POST', '/complete');
      return {};
    }),
    fail: vi.fn(async () => ({})),
    cancelAck: vi.fn(async () => ({})),
  };
  const adapter: AgentAdapter = {
    provider: 'echo',
    detect: async () => null,
    capabilities: () => ({ resume: true, steering: false, briefFile: 'AGENTS.md' }),
    start: vi.fn(async (spec) => {
      specs.push(spec);
      return {
        events: (async function* () {
          yield { type: 'text' as const, content: 'working', at: new Date().toISOString() };
        })(),
        kill: async () => {},
        result: Promise.resolve({ exitCode: 0, sessionId: 'session-same', visibleEvents: 1, usage: { provider: 'echo', inputTokens: 10, outputTokens: 2 } }),
      };
    }),
  };
  const run = claimedRun();
  return {
    run,
    specs,
    api,
    adapter,
    state,
    setInputs: (value: ClaimedTriggerComment[]) => {
      inputs = value;
    },
    execute: () => executeRun(run, { api, adapter, serverUrl: run.server.url, workspacesRoot: root, idleWatchdogMs: 0, logger: silentLogger }),
  };
}

describe('same-run comment delivery', () => {
  it('continues on the same session and checkout, excludes claimed input, and sums usage', async () => {
    const h = setup();
    const initial = h.run.triggers[0]!.comment!;
    h.setInputs([initial, comment('c10'), comment('c11')]);
    expect(await h.execute()).toEqual({ kind: 'completed' });
    expect(h.specs).toHaveLength(2);
    expect(h.specs[1]).toMatchObject({ runId: h.specs[0]!.runId, workDir: h.specs[0]!.workDir, resumeSessionId: 'session-same' });
    expect(h.specs[1]!.env.NOCOPROJECT_TOKEN).toBe(h.specs[0]!.env.NOCOPROJECT_TOKEN);
    expect(h.specs[1]!.prompt).toContain('Please handle c10');
    expect(h.specs[1]!.prompt).toContain('Please handle c11');
    expect(h.specs[1]!.prompt).not.toContain(initial.content);
    expect(h.api.start).toHaveBeenCalledWith(h.run.run.id, expect.objectContaining({ acceptsInput: true }));
    expect(h.api.complete).toHaveBeenCalledWith(
      h.run.run.id,
      expect.objectContaining({ handledInputIds: ['c9', 'c10', 'c11'], usage: expect.objectContaining({ inputTokens: 20, outputTokens: 4 }) }),
    );
  });

  it('handles a comment racing the final complete request', async () => {
    const h = setup();
    vi.mocked(h.api.complete).mockImplementationOnce(async () => {
      h.setInputs([comment('late')]);
      throw new HttpError(409, 'RUN_INPUT_PENDING', 'pending', 'POST', '/complete');
    });
    expect(await h.execute()).toEqual({ kind: 'completed' });
    expect(h.specs).toHaveLength(2);
    expect(h.specs[1]!.prompt).toContain('Please handle late');
    expect(h.api.complete).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation before a continuation', async () => {
    const h = setup();
    h.setInputs([comment('never')]);
    vi.mocked(h.api.status).mockResolvedValue({ status: 'running', cancelRequested: true, inputs: [comment('never')] });
    expect(await h.execute()).toEqual({ kind: 'cancelled' });
    expect(h.specs).toHaveLength(1);
    expect(h.api.cancelAck).toHaveBeenCalledOnce();
    expect(h.api.complete).not.toHaveBeenCalled();
  });

  it('honors cancellation racing the completion request', async () => {
    const h = setup();
    vi.mocked(h.api.complete).mockRejectedValue(new HttpError(409, 'RUN_CANCEL_REQUESTED', 'cancelled', 'POST', '/complete'));
    expect(await h.execute()).toEqual({ kind: 'cancelled' });
    expect(h.api.cancelAck).toHaveBeenCalledOnce();
    expect(h.api.fail).not.toHaveBeenCalled();
  });

  it('does not report successful completion if the server rejects it', async () => {
    const h = setup();
    vi.mocked(h.api.complete).mockRejectedValue(new HttpError(403, 'RUN_NOT_OWNED', 'forbidden', 'POST', '/complete'));
    expect(await h.execute()).toEqual({ kind: 'failed', reason: 'runtimeRecovery' });
    expect(h.api.fail).toHaveBeenCalledOnce();
  });

  it('remains compatible with an older server that omits inputs', async () => {
    const h = setup();
    vi.mocked(h.api.status).mockResolvedValue({ status: 'running', cancelRequested: false });
    expect(await h.execute()).toEqual({ kind: 'completed' });
    expect(h.specs).toHaveLength(1);
  });
});
