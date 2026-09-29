/**
 * NP-150: a daemon the server cannot use stays visible. It keeps heartbeating, stops claiming, records the upgrade
 * command in daemon.state.json, recovers when the server accepts it again, and falls back to protocol 1 on a server
 * from before NP-150.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonCompatibility } from '../src/protocol.js';
import { startDaemon, waitFor, type Harness } from './helpers/daemon-harness.js';
import { MockServer } from './helpers/mock-server.js';

let mock: MockServer | undefined;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.daemon.stop(5000);
  await mock?.stop();
  harness = undefined;
  mock = undefined;
});

function verdict(status: DaemonCompatibility['status']): DaemonCompatibility {
  return {
    status,
    reason: status === 'unsupported' ? 'daemonTooOld' : 'current',
    negotiatedProtocol: 2,
    protocols: { min: 2, current: 3 },
    daemonVersion: '0.5.0',
    latestVersion: '0.6.0',
    minVersion: '0.6.0',
    updateAvailable: status !== 'ok',
    downloadPath: '/assets/cli/nocoproject-cli-0.6.0.tgz',
  };
}

const claimsWithSlots = (m: MockServer) => m.callsTo(/runs\/claim/).filter((c) => c.body.slots.length > 0);

describe('daemon compatibility', () => {
  it('keeps heartbeating without claiming while the server requires an upgrade, and resumes after', async () => {
    mock = new MockServer();
    mock.compatibility = verdict('unsupported');
    await mock.start();
    harness = await startDaemon(mock);
    const beats = mock.callsTo(/daemon\/heartbeat/).length;
    await waitFor(() => mock!.callsTo(/daemon\/heartbeat/).length >= beats + 2, 5000, 'heartbeats while unsupported');
    expect(claimsWithSlots(mock)).toHaveLength(0);
    const snapshot = harness.daemon.snapshot();
    expect(snapshot.upgradeRequired).toMatchObject({ reason: 'daemonTooOld', latestVersion: '0.6.0', command: 'nocoproject upgrade' });
    expect(snapshot.protocolMismatch).toBe(true);
    const state = JSON.parse(readFileSync(join(harness.home, 'daemon.state.json'), 'utf8')) as typeof snapshot;
    expect(state.upgradeRequired?.command).toBe('nocoproject upgrade');
    expect(state.execPath).toBe(process.execPath);
    expect(harness.logs.join('\n')).toContain('Upgrade with: nocoproject upgrade');

    // The server now accepts it (for example, it was rolled back): the next heartbeat lifts the pause.
    mock.compatibility = verdict('ok');
    mock.addIssue({ id: 'i1', identifier: 'NP-1', title: 'After' });
    const runId = mock.enqueue('i1');
    await waitFor(() => harness!.daemon.snapshot().upgradeRequired === null, 5000, 'cleared');
    await waitFor(() => mock!.runs.has(runId), 5000, 'claimed after recovery');
  });

  it('falls back to protocol 1 on a server from before NP-150 and still works', async () => {
    mock = new MockServer({ legacyServer: true });
    await mock.start();
    harness = await startDaemon(mock);
    const registers = mock.callsTo(/daemon\/register/).map((c) => c.body.protocolVersion);
    expect(registers).toEqual([2, 1]);
    expect(harness.daemon.snapshot()).toMatchObject({ negotiatedProtocol: 1, upgradeRequired: null });
    await waitFor(() => mock!.callsTo(/daemon\/heartbeat/).length >= 1, 5000, 'heartbeat');
    expect(mock.callsTo(/daemon\/heartbeat/)[0]?.body.protocolVersion).toBe(1);
    mock.addIssue({ id: 'i1', identifier: 'NP-1', title: 'Legacy' });
    const runId = mock.enqueue('i1');
    await waitFor(() => mock!.runs.has(runId), 5000, 'claimed on the legacy server');
    expect(claimsWithSlots(mock)[0]?.body.configurationProtocol).toBe(1);
  });

  it('names the manual command when the server only answers 426', async () => {
    mock = new MockServer({ protocolMismatch: true });
    await mock.start();
    harness = await startDaemon(mock);
    expect(harness.daemon.snapshot().upgradeRequired).toMatchObject({ reason: 'protocolMismatch' });
    expect(harness.daemon.snapshot().upgradeRequired?.command).toBe('nocoproject upgrade');
  });
});
