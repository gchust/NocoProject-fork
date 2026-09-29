// @vitest-environment node
/**
 * Computer credentials and personal-key hardening (NP-150) through the whole application (isolated SQLite, the real
 * authentication and API Keys plugins): a computer credential authenticates `/np/daemon/*` only, is bound to the
 * daemon it first registered, stops working when revoked, and stays out of the self-service key endpoints; a personal
 * key can no longer mint keys, list sessions or issue computer credentials.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPUTER_KEY_HEADER,
  LATEST_CLI_VERSION,
  PROTOCOL_VERSION,
} from '../../server/modules/shared/protocol.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const REGISTER = {
  deviceName: 'ci-box',
  version: LATEST_CLI_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  runtimes: [
    {
      provider: 'echo',
      version: '1',
      capabilities: { resume: false, steering: false },
    },
  ],
};

async function open() {
  // A trusted origin, so cookie-authenticated writes (issuing a computer credential) pass the CSRF check.
  const app = await startNpApp(cleanups, 'nocoproject-computers-', {
    config: { app: { publicOrigin: 'http://localhost' } },
  });
  const base = `http://localhost${app.application.publicBasePath}/api`;
  const call = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ) =>
    app.fetch(
      new Request(`${base}${url}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const signIn = await call(
    'POST',
    '/auth/sign-in/username',
    {},
    { username: 'nocobase', password: 'admin123' },
  );
  expect(signIn.status).toBe(200);
  const cookie = { cookie: cookiesOf(signIn), origin: 'http://localhost' };
  return { call, cookie };
}

describe('computer credentials through the application', () => {
  it('issues a credential that works on the daemon API only, bound to one daemon, until revoked', async () => {
    const { call, cookie } = await open();
    const created = await call('POST', '/np/computers', cookie, {
      name: 'Build box',
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as {
      data: { computer: { id: string; keyStart: string }; key: string };
    };
    expect(data.key).toMatch(/^npc_/u);
    const machine = { [COMPUTER_KEY_HEADER]: data.key };

    const registered = await call('POST', '/np/daemon/register', machine, {
      ...REGISTER,
      daemonId: 'box-1',
    });
    expect(registered.status).toBe(200);
    const runtimes = (
      (await registered.json()) as { data: { runtimes: { id: string }[] } }
    ).data.runtimes;
    expect(
      (
        await call('POST', '/np/daemon/heartbeat', machine, {
          daemonId: 'box-1',
          runtimeIds: runtimes.map((runtime) => runtime.id),
        })
      ).status,
    ).toBe(200);
    // Bound to box-1: another daemon id is refused.
    const other = await call('POST', '/np/daemon/register', machine, {
      ...REGISTER,
      daemonId: 'box-2',
    });
    expect(other.status).toBe(403);
    await expect(other.json()).resolves.toMatchObject({
      code: 'COMPUTER_DAEMON_MISMATCH',
    });
    // Not a session: every other API refuses it.
    expect((await call('GET', '/np/me', machine)).status).toBe(401);
    expect((await call('GET', '/np/issues', machine)).status).toBe(401);
    expect((await call('GET', '/auth/api-key/list', machine)).status).toBe(401);
    // The runtime records how it connected.
    const list = (await (await call('GET', '/np/runtimes', cookie)).json()) as {
      data: { daemonId: string; daemon: { credential: string } }[];
    };
    expect(
      list.data.find((runtime) => runtime.daemonId === 'box-1')?.daemon
        .credential,
    ).toBe('computer');
    // It stays out of the self-service key list and cannot be changed there.
    const keys = (await (
      await call('GET', '/auth/api-key/list', cookie)
    ).json()) as unknown;
    expect(JSON.stringify(keys)).not.toContain(data.computer.keyStart);
    expect(
      (await call('GET', '/auth/api-key/list?configId=np-computer', cookie))
        .status,
    ).toBe(403);

    const computers = (await (
      await call('GET', '/np/computers', cookie)
    ).json()) as {
      data: { id: string; daemonId: string; canRevoke: boolean }[];
    };
    expect(computers.data[0]).toMatchObject({
      daemonId: 'box-1',
      canRevoke: true,
    });

    const revoked = await call(
      'DELETE',
      `/np/computers/${data.computer.id}`,
      cookie,
    );
    expect(revoked.status).toBe(200);
    const after = await call('POST', '/np/daemon/heartbeat', machine, {
      daemonId: 'box-1',
      runtimeIds: runtimes.map((runtime) => runtime.id),
    });
    expect(after.status).toBe(401);
    await expect(after.json()).resolves.toMatchObject({
      code: 'COMPUTER_REVOKED',
    });
    const offline = (await (
      await call('GET', '/np/runtimes', cookie)
    ).json()) as {
      data: { daemonId: string; status: string }[];
    };
    expect(
      offline.data.find((runtime) => runtime.daemonId === 'box-1')?.status,
    ).toBe('offline');
    expect(
      (
        await call('GET', '/np/daemon/compatibility', {
          [COMPUTER_KEY_HEADER]: 'npc_nope',
        })
      ).status,
    ).toBe(401);
  });

  it('keeps a personal key from minting keys, reading sessions or issuing computer credentials', async () => {
    const { call, cookie } = await open();
    const created = await call('POST', '/auth/api-key/create', cookie, {
      name: 'personal',
    });
    expect(created.status).toBe(200);
    const key = {
      'x-api-key': ((await created.json()) as { key: string }).key,
    };

    expect((await call('GET', '/np/me', key)).status).toBe(200);
    const mint = await call('POST', '/auth/api-key/create', key, {
      name: 'successor',
    });
    expect(mint.status).toBe(403);
    await expect(mint.json()).resolves.toMatchObject({
      code: 'API_KEY_FORBIDDEN_ACTION',
    });
    expect((await call('GET', '/auth/list-sessions', key)).status).toBe(403);
    expect((await call('GET', '/auth/list-sessions', cookie)).status).toBe(200);
    const computer = await call('POST', '/np/computers', key, { name: 'x' });
    expect(computer.status).toBe(403);
    await expect(computer.json()).resolves.toMatchObject({
      code: 'COMPUTER_NEEDS_SIGN_IN',
    });
    // Older CLIs keep working on the daemon API with the personal key (the compatibility window).
    const legacy = await call('POST', '/np/daemon/register', key, {
      ...REGISTER,
      daemonId: 'legacy',
    });
    expect(legacy.status).toBe(200);
    const list = (await (await call('GET', '/np/runtimes', cookie)).json()) as {
      data: { daemonId: string; daemon: { credential: string } }[];
    };
    expect(
      list.data.find((runtime) => runtime.daemonId === 'legacy')?.daemon
        .credential,
    ).toBe('personalKey');
  });

  it('wakes a long-polling daemon without a WebSocket session', async () => {
    const { call, cookie } = await open();
    const created = (await (
      await call('POST', '/np/computers', cookie, { name: 'Poller' })
    ).json()) as { data: { key: string } };
    const machine = { [COMPUTER_KEY_HEADER]: created.data.key };
    const first = (await (
      await call('GET', '/np/daemon/wakeups', machine)
    ).json()) as { data: { cursor: number; events: unknown[] } };
    expect(first.data.events).toEqual([]);
    const idle = (await (
      await call(
        'GET',
        `/np/daemon/wakeups?after=${first.data.cursor}&timeout=0`,
        machine,
      )
    ).json()) as { data: { events: unknown[] } };
    expect(idle.data.events).toEqual([]);
  });
});
