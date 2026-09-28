import { afterEach, describe, expect, it } from 'vitest';
import { ClaimLoop, distributeSlots } from '../src/daemon/claim.js';
import type { ClaimedRun, DaemonClaimRequest } from '../src/protocol.js';
import { silentLogger } from '../src/util/log.js';
import { claimedRun } from './helpers/fixtures.js';
import { startDaemon, waitFor, type Harness } from './helpers/daemon-harness.js';
import { MockServer } from './helpers/mock-server.js';

describe('distributeSlots', () => {
  it('splits slots evenly across runtimes', () => {
    expect(distributeSlots(20, ['a', 'b', 'c'])).toEqual([
      { runtimeId: 'a', free: 7 },
      { runtimeId: 'b', free: 7 },
      { runtimeId: 'c', free: 6 },
    ]);
    expect(distributeSlots(1, ['a', 'b'])).toEqual([{ runtimeId: 'a', free: 1 }]);
    expect(distributeSlots(0, ['a'])).toEqual([]);
  });
});

describe('ClaimLoop', () => {
  it('never exceeds maxConcurrent and coalesces triggers', async () => {
    const requests: DaemonClaimRequest[] = [];
    let backlog = 7;
    const release: (() => void)[] = [];
    let inFlight = 0;
    const loop = new ClaimLoop({
      api: {
        claim: async (body) => {
          requests.push(body);
          await new Promise((r) => setTimeout(r, 5));
          const runs: ClaimedRun[] = [];
          for (const s of body.slots) for (let i = 0; i < s.free && backlog > 0; i++, backlog--) runs.push(claimedRun({ run: { ...claimedRun().run, id: `r${backlog}`, runtimeId: s.runtimeId } }));
          return { runs };
        },
      },
      daemonId: 'd',
      maxConcurrent: 3,
      runtimeIds: () => ['rt1'],
      execute: () => {
        inFlight += 1;
        expect(inFlight).toBeLessThanOrEqual(3);
        return new Promise<void>((r) => release.push(() => { inFlight -= 1; r(); }));
      },
      logger: silentLogger,
      onProtocolMismatch: () => undefined,
    });
    loop.trigger('a');
    loop.trigger('b');
    loop.trigger('c');
    await waitFor(() => loop.activeRuns === 3, 2000, 'three active');
    expect(requests.every((r) => r.slots.every((s) => s.free <= 3))).toBe(true);
    while (backlog > 0 || release.length > 0) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 20));
    }
    await loop.drain();
    expect(backlog).toBe(0);
    expect(loop.activeRuns).toBe(0);
  });
});

describe('lease renewal', () => {
  let mock: MockServer | undefined;
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.daemon.stop(5000);
    await mock?.stop();
  });

  it('renews the lease while the run is still being prepared', async () => {
    mock = new MockServer({ startDelayMs: 450 });
    await mock.start();
    harness = await startDaemon(mock, { intervals: { leaseMs: 100 } });
    mock.addIssue({ id: 'i1', identifier: 'NP-1' });
    const runId = mock.enqueue('i1');
    await waitFor(() => mock?.runs.get(runId)?.status === 'completed', 20_000, 'completion');
    expect(mock.callsTo(new RegExp(`runs/${runId}/lease`)).length).toBeGreaterThanOrEqual(2);
  });
});
