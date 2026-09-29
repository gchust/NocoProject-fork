// @vitest-environment node
/**
 * Daemon version compatibility (NP-150) on a real PostgreSQL: the compatibility matrix, an unsupported daemon kept
 * visible (`upgrade_required`, heartbeats, empty claims, never swept offline), the owner's inbox card, and recovery.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { evaluateDaemon } from '../../server/modules/runtime/daemon-compat.ts';
import type { NpServices } from '../../server/modules/services.ts';
import {
  LATEST_CLI_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOLS,
  compareVersions,
  upgradeCommand,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  buildServices,
  createAgent,
  openNpTestDatabase,
  resetData,
  runRows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_daemon_compat');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-daemon-compat] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
});

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);

function register(
  daemonId: string,
  daemon: { version: string; protocolVersion?: number },
) {
  return services.runtimes.register(ALICE.id!, {
    daemonId,
    deviceName: `${daemonId}-mac`,
    version: daemon.version,
    protocolVersion: daemon.protocolVersion as number,
    runtimes: [
      {
        provider: 'echo',
        version: '1',
        capabilities: { resume: true, steering: false },
      },
    ],
  });
}

async function queueWork(runtimeId: string): Promise<void> {
  const agentId = await createAgent(services, ALICE, runtimeId, 'Worker');
  await services.issues.create(ALICE, {
    title: 'Work',
    executor: { type: 'agent', id: agentId },
  });
}

async function upgradeCards() {
  const list = await services.inbox.list(ALICE, {});
  return list.data.filter(
    (item) => (item.type as string) === 'runtime_upgrade_required',
  );
}

describe('evaluateDaemon', () => {
  it.each([
    // CLI 0.3.x: protocol 1 without NP-125's configuration.
    [
      { protocolVersion: 1, version: '0.3.2' },
      'unsupported',
      'daemonTooOld',
      1,
    ],
    // CLI 0.4.0: protocol 1 with configuration, inside the compatibility window.
    [
      { protocolVersion: 1, version: '0.4.0' },
      'deprecated',
      'protocolDeprecated',
      1,
    ],
    [{ protocolVersion: 2, version: '0.5.0' }, 'ok', 'current', 2],
    // A newer daemon that can still speak this server's protocol.
    [
      { protocolVersion: 3, minProtocolVersion: 2, version: '0.9.0' },
      'ok',
      'current',
      2,
    ],
    [
      { protocolVersion: 3, minProtocolVersion: 3, version: '0.9.0' },
      'unsupported',
      'daemonTooNew',
      null,
    ],
    // No protocol at all: a protocol 1 daemon.
    [{ version: '0.4.1' }, 'deprecated', 'protocolDeprecated', 1],
  ] as const)('%o → %s (%s)', (identity, status, reason, negotiated) => {
    expect(evaluateDaemon(identity)).toMatchObject({
      status,
      reason,
      negotiatedProtocol: negotiated,
    });
  });

  it('judges a protocol 1 claim by the configuration protocol it carries', () => {
    const identity = { protocolVersion: 1, version: '0.4.0' };
    expect(evaluateDaemon({ ...identity, claim: {} }).status).toBe(
      'unsupported',
    );
    expect(
      evaluateDaemon({ ...identity, claim: { configurationProtocol: 1 } })
        .status,
    ).toBe('deprecated');
  });

  it('speaks the protocol it accepts and names the upgrade command', () => {
    expect(PROTOCOL_VERSION).toBe(SUPPORTED_PROTOCOLS.current);
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1);
    expect(compareVersions('0.5.0-beta.1', '0.5.0')).toBe(0);
    expect(upgradeCommand('https://np.test/main/', '0.4.0')).toBe(
      `npm i -g https://np.test/main/assets/cli/nocoproject-cli-${LATEST_CLI_VERSION}.tgz && nocoproject daemon install`,
    );
    expect(upgradeCommand('https://np.test/main', '0.5.0')).toBe(
      'nocoproject upgrade',
    );
  });
});

describe.skipIf(!db)('daemon compatibility (PostgreSQL)', () => {
  it('keeps an unsupported daemon visible until it upgrades', async () => {
    const registered = await register('old', {
      version: '0.3.2',
      protocolVersion: 1,
    });
    // The old daemon compares this with what it speaks, so it must stay 1.
    expect(registered.protocolVersion).toBe(1);
    expect(registered.compatibility).toMatchObject({
      status: 'unsupported',
      reason: 'daemonTooOld',
    });
    const runtimeId = registered.runtimes[0]!.id;
    await queueWork(runtimeId);

    const [runtime] = await services.runtimes.list();
    expect(runtime).toMatchObject({
      status: 'upgrade_required',
      online: false,
      daemon: {
        version: '0.3.2',
        status: 'unsupported',
        updateAvailable: true,
      },
    });
    const [card] = await upgradeCards();
    expect(card).toMatchObject({
      kind: 'info',
      issueId: null,
      title: 'old-mac',
      payload: {
        daemonId: 'old',
        daemonVersion: '0.3.2',
        latestVersion: LATEST_CLI_VERSION,
      },
    });

    // Heartbeats are accepted, claims answered with no work (not 426), and the run waits.
    await expect(
      services.runtimes.heartbeat(ALICE.id!, {
        daemonId: 'old',
        runtimeIds: [runtimeId],
      }),
    ).resolves.toMatchObject({ compatibility: { status: 'unsupported' } });
    await expect(
      services.claims.claim(
        ALICE.id!,
        { daemonId: 'old', slots: [{ runtimeId, free: 1 }] },
        'http://test',
      ),
    ).resolves.toMatchObject({ runs: [] });
    expect(await runRows(db!, "status = 'queued'")).toHaveLength(1);

    // Silence does not turn it into "offline": it still needs an upgrade.
    expect((await services.sweeper.sweep(later(600))).runtimesOffline).toBe(0);
    expect((await services.runtimes.list())[0]!.status).toBe(
      'upgrade_required',
    );
    expect(await upgradeCards()).toHaveLength(1);

    // The upgraded daemon registers again: online, the card resolved, the run claimed.
    const upgraded = await register('old', {
      version: LATEST_CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(upgraded.compatibility?.status).toBe('ok');
    expect((await services.runtimes.list())[0]).toMatchObject({
      status: 'online',
      online: true,
      daemon: { status: 'ok', updateAvailable: false },
    });
    expect((await upgradeCards())[0]!.resolvedAt).not.toBeNull();
    const claimed = await services.claims.claim(
      ALICE.id!,
      { daemonId: 'old', slots: [{ runtimeId, free: 1 }] },
      'http://test',
    );
    expect(claimed.runs).toHaveLength(1);
    expect(claimed.runs[0]!.server.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('resolves the card when the upgraded daemon registers other tools after a stop', async () => {
    const old = await register('swap', {
      version: '0.3.2',
      protocolVersion: 1,
    });
    expect(await upgradeCards()).toHaveLength(1);
    // `daemon install` stops the old daemon (deregister), and the new one registers claude instead of echo.
    await services.runtimes.deregister(ALICE.id!, 'swap');
    const upgraded = await services.runtimes.register(ALICE.id!, {
      daemonId: 'swap',
      deviceName: 'swap-mac',
      version: LATEST_CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runtimes: [
        {
          provider: 'claude',
          version: '2',
          capabilities: { resume: true, steering: false },
        },
      ],
    });
    expect(upgraded.runtimes[0]!.id).not.toBe(old.runtimes[0]!.id);
    expect((await upgradeCards())[0]!.resolvedAt).not.toBeNull();
    const runtimes = await services.runtimes.list();
    expect(runtimes.map((item) => [item.provider, item.status]).sort()).toEqual(
      [
        ['claude', 'online'],
        ['echo', 'offline'],
      ],
    );
    // Later heartbeats do not announce anything again.
    await services.runtimes.heartbeat(ALICE.id!, {
      daemonId: 'swap',
      runtimeIds: [upgraded.runtimes[0]!.id],
    });
    expect(await upgradeCards()).toHaveLength(1);
  });

  it('lets a 0.4.0 daemon keep working inside the compatibility window', async () => {
    const registered = await register('window', {
      version: '0.4.0',
      protocolVersion: 1,
    });
    expect(registered.protocolVersion).toBe(1);
    expect(registered.compatibility).toMatchObject({
      status: 'deprecated',
      updateAvailable: true,
    });
    const runtimeId = registered.runtimes[0]!.id;
    await queueWork(runtimeId);
    const claimed = await services.claims.claim(
      ALICE.id!,
      {
        daemonId: 'window',
        configurationProtocol: 1,
        slots: [{ runtimeId, free: 1 }],
      },
      'http://test',
    );
    expect(claimed.runs).toHaveLength(1);
    expect(claimed.runs[0]!.server.protocolVersion).toBe(1);
    expect((await services.runtimes.list())[0]).toMatchObject({
      status: 'online',
      daemon: { status: 'deprecated', updateAvailable: true },
    });
    expect(await upgradeCards()).toHaveLength(0);
  });

  it('catches a daemon registered before NP-150 at its first claim', async () => {
    const registered = await register('legacy', {
      version: LATEST_CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
    const runtimeId = registered.runtimes[0]!.id;
    // What register stored before NP-150: only the device name and the CLI version.
    await db!.database
      .query()
      .updateTable('runtimes')
      .set({
        deviceInfo: JSON.stringify({
          deviceName: 'legacy-mac',
          daemonVersion: '0.3.0',
        }),
      })
      .where('id', '=', runtimeId)
      .execute();
    await queueWork(runtimeId);
    await expect(
      services.claims.claim(
        ALICE.id!,
        { daemonId: 'legacy', slots: [{ runtimeId, free: 1 }] },
        'http://test',
      ),
    ).resolves.toMatchObject({
      runs: [],
      compatibility: { status: 'unsupported' },
    });
    expect((await services.runtimes.list())[0]!.status).toBe(
      'upgrade_required',
    );
    expect(await upgradeCards()).toHaveLength(1);
  });

  it('re-evaluates a daemon from the identity its heartbeat reports', async () => {
    const registered = await register('hb', {
      version: LATEST_CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
    const runtimeId = registered.runtimes[0]!.id;
    await expect(
      services.runtimes.heartbeat(ALICE.id!, {
        daemonId: 'hb',
        runtimeIds: [runtimeId],
        version: '0.3.0',
        protocolVersion: 1,
      }),
    ).resolves.toMatchObject({ compatibility: { status: 'unsupported' } });
    expect((await services.runtimes.list())[0]).toMatchObject({
      status: 'upgrade_required',
      daemon: { version: '0.3.0' },
    });
  });

  it('fails a running run once an upgrade_required runtime has gone silent', async () => {
    const registered = await register('busy', {
      version: LATEST_CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
    const runtimeId = registered.runtimes[0]!.id;
    await queueWork(runtimeId);
    const claimed = await services.claims.claimOne(runtimeId);
    await services.runs.start(claimed!.runId, { workDir: '/w' });
    await services.runtimes.heartbeat(ALICE.id!, {
      daemonId: 'busy',
      runtimeIds: [runtimeId],
      version: '0.3.0',
      protocolVersion: 1,
    });
    expect((await services.sweeper.sweep(later(200))).runningOrphaned).toBe(0);
    expect(
      (await services.sweeper.sweep(later(3 * 3600 + 1))).runningOrphaned,
    ).toBe(1);
  });
});
