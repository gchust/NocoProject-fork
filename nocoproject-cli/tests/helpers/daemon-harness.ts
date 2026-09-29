import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAdapters } from '../../src/daemon/adapters/index.js';
import { Daemon, type DaemonIntervals } from '../../src/daemon/lifecycle.js';
import { createLogger } from '../../src/util/log.js';
import { API_KEY, COMPUTER_KEY, type MockServer } from './mock-server.js';

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 15_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface Harness {
  readonly daemon: Daemon;
  readonly home: string;
  readonly logs: string[];
}

export async function startDaemon(
  mock: MockServer,
  opts: { pollIntervalMs?: number; intervals?: DaemonIntervals; idleWatchdogMs?: number; maxConcurrent?: number; provider?: string; computerKey?: boolean } = {},
): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'ncp-e2e-'));
  const logs: string[] = [];
  const provider = opts.provider ?? 'echo';
  const { detected } = await detectAdapters([provider]);
  if (detected.length === 0) throw new Error(`${provider} adapter not found (for echo: is dist/ built?)`);
  const daemon = new Daemon({
    config: {
      home,
      serverUrl: mock.url,
      ...(opts.computerKey ? { apiKey: undefined, computerKey: COMPUTER_KEY } : { apiKey: API_KEY }),
      daemonId: 'daemon-test-1',
      deviceName: 'test-box',
    },
    settings: {
      maxConcurrent: opts.maxConcurrent ?? 4,
      pollIntervalMs: opts.pollIntervalMs ?? 60_000,
      idleWatchdogMs: opts.idleWatchdogMs ?? 60_000,
      workspacesRoot: join(home, 'workspaces'),
      providers: [provider],
    },
    logger: createLogger({ level: 'debug', write: (line) => logs.push(line) }),
    adapters: detected,
    intervals: { heartbeatMs: 200, leaseMs: 100, cancelPollMs: 60_000, flushMs: 50, ...opts.intervals },
  });
  await daemon.start();
  return { daemon, home, logs };
}
