// @vitest-environment node
/**
 * Computer credentials (NP-150) on a real PostgreSQL with an in-memory key store: who may list and revoke, the
 * daemon binding of `runs/:id`, a disabled owner, and the long-poll wakeups. The real API Keys plugin is covered by
 * np-computers-app.test.ts.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ComputerKeys } from '../../server/modules/computer/computer.service.ts';
import { createDaemonWakeups } from '../../server/modules/runtime/daemon-wakeups.ts';
import type { NpServices } from '../../server/modules/services.ts';
import { createDomainEventBus } from '../../server/modules/shared/events.ts';
import {
  LATEST_CLI_VERSION,
  PROTOCOL_VERSION,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  createAgent,
  openNpTestDatabase,
  resetData,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_computers');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-computers] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

/** Keys by secret; disabled ones stop verifying, like the plugin's. */
function memoryKeys(): ComputerKeys {
  const keys = new Map<
    string,
    { keyId: string; userId: string; enabled: boolean }
  >();
  return {
    async create(_conn, input) {
      const secret = `npc_${randomUUID()}`;
      const keyId = randomUUID();
      keys.set(secret, { keyId, userId: input.userId, enabled: true });
      return { keyId, keyStart: secret.slice(0, 8), secret };
    },
    async verify(secret) {
      const key = keys.get(secret);
      return key?.enabled ? { keyId: key.keyId, userId: key.userId } : null;
    },
    async disable(_conn, keyId) {
      for (const key of keys.values())
        if (key.keyId === keyId) key.enabled = false;
    },
  };
}

let services: NpServices;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  const keys = memoryKeys();
  services = buildServices(db.database, { computerKeys: () => keys }).services;
});

describe.skipIf(!db)('computer credentials (PostgreSQL)', () => {
  it('lets the owner and admins see and revoke, nobody else', async () => {
    await setRole(db!, CAROL, 'admin');
    const { computer, key } = await services.computers.create(ALICE, {
      name: '  Studio  ',
    });
    expect(computer).toMatchObject({ name: 'Studio', canRevoke: true });
    expect(key).toMatch(/^npc_/u);
    expect(await services.computers.list(BOB)).toEqual([]);
    expect((await services.computers.list(CAROL))[0]).toMatchObject({
      id: computer.id,
      canRevoke: true,
    });
    await expect(
      services.computers.revoke(BOB, computer.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.computers.create({ ...ALICE, via: 'api_key' }, { name: 'x' }),
    ).rejects.toMatchObject({ code: 'COMPUTER_NEEDS_SIGN_IN' });
    const revoked = await services.computers.revoke(CAROL, computer.id);
    expect(revoked).toMatchObject({ canRevoke: false });
    expect(revoked.revokedAt).not.toBeNull();
    await expect(services.computers.authenticate(key)).rejects.toMatchObject({
      code: 'COMPUTER_REVOKED',
    });
  });

  it('binds the credential to its first daemon and to that daemon’s runs', async () => {
    const { key } = await services.computers.create(ALICE, { name: 'A' });
    const caller = await services.computers.authenticate(key);
    await services.computers.bindDaemon(caller, 'daemon-a');
    const bound = await services.computers.authenticate(key);
    expect(bound.daemonId).toBe('daemon-a');
    await expect(
      services.computers.bindDaemon(bound, 'daemon-b'),
    ).rejects.toMatchObject({ code: 'COMPUTER_DAEMON_MISMATCH' });

    // A run of another daemon of the same owner is refused.
    const other = await services.runtimes.register(ALICE.id!, {
      daemonId: 'daemon-b',
      deviceName: 'b',
      version: LATEST_CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runtimes: [
        {
          provider: 'echo',
          version: '1',
          capabilities: { resume: true, steering: false },
        },
      ],
    });
    const agentId = await createAgent(
      services,
      ALICE,
      other.runtimes[0]!.id,
      'B',
    );
    await services.issues.create(ALICE, {
      title: 'On b',
      executor: { type: 'agent', id: agentId },
    });
    const claimed = await services.claims.claimOne(other.runtimes[0]!.id);
    await expect(
      services.computers.requireRun(bound, claimed!.runId),
    ).rejects.toMatchObject({ code: 'COMPUTER_DAEMON_MISMATCH' });
  });

  it('refuses the credential of a disabled owner', async () => {
    const { key } = await services.computers.create(ALICE, { name: 'A' });
    await db!.knex.raw(
      `UPDATE "${db!.schema}"."user" SET disabled_at = now() WHERE id = ?`,
      [ALICE.id],
    );
    await expect(services.computers.authenticate(key)).rejects.toMatchObject({
      code: 'COMPUTER_OWNER_DISABLED',
    });
    await expect(
      services.computers.authenticate('npc_unknown'),
    ).rejects.toMatchObject({ code: 'COMPUTER_KEY_INVALID' });
  });
});

describe('daemon wakeups', () => {
  it('hands each waiting daemon of the owner the messages after its cursor', async () => {
    const bus = createDomainEventBus();
    const wakeups = createDaemonWakeups(bus);
    const start = await wakeups.wait('u1', null, 0);
    expect(start.events).toEqual([]);
    const pending = wakeups.wait('u1', start.cursor, 5000);
    const other = wakeups.wait('u2', start.cursor, 50);
    bus.emit({ type: 'daemon.workAvailable', userId: 'u1', runtimeId: 'r1' });
    await expect(pending).resolves.toMatchObject({
      events: [{ kind: 'workAvailable', runtimeId: 'r1' }],
    });
    await expect(other).resolves.toMatchObject({ events: [] });
    // A second daemon polling late still sees it.
    await expect(wakeups.wait('u1', start.cursor, 0)).resolves.toMatchObject({
      events: [{ kind: 'workAvailable', runtimeId: 'r1' }],
    });
    wakeups.close();
  });
});
