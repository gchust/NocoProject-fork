// @vitest-environment node
/**
 * The whole application (isolated SQLite, real authentication and API Keys plugins) answering a daemon: an
 * `x-api-key` resolves to the key owner's session on the NocoProject daemon API and on the realtime WebSocket, so the
 * daemon can subscribe to its user topic `np:daemon` and receive `workAvailable`. Claiming itself needs PostgreSQL and
 * is covered by np-claim.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AppWebSocket,
  AppWebSocketReadyState,
} from '@nocobase/app-websocket';

import type { StandaloneServer } from '../../server/standalone.ts';
import { cookiesOf, startNpApp } from './np-app-harness.ts';
import {
  LATEST_CLI_VERSION,
  PROTOCOL_VERSION,
} from '../../server/modules/shared/protocol.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function startApp(): Promise<StandaloneServer> {
  return startNpApp(cleanups, 'nocoproject-daemon-auth-');
}

interface TestSocket extends AppWebSocket {
  readonly messages: Record<string, unknown>[];
}

function createTestSocket(): TestSocket {
  let readyState: AppWebSocketReadyState = 1;
  const messages: Record<string, unknown>[] = [];
  return {
    url: new URL('ws://localhost/ws'),
    protocol: null,
    messages,
    get readyState() {
      return readyState;
    },
    send(data: unknown) {
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
    },
    close() {
      readyState = 3;
    },
  } as TestSocket;
}

async function openSocket(
  app: StandaloneServer,
  headers: Record<string, string>,
): Promise<TestSocket> {
  const request = new Request(
    `http://localhost${app.application.publicBasePath}/ws`,
    { headers },
  );
  const handler = await app.websocket?.(request);
  if (!handler) throw new Error('No WebSocket handler.');
  const socket = createTestSocket();
  const events = handler as unknown as {
    onOpen?: (event: unknown, ws: AppWebSocket) => void;
    onMessage: (event: { data: string }, ws: AppWebSocket) => void;
  };
  events.onOpen?.({}, socket);
  events.onMessage(
    {
      data: JSON.stringify({ type: 'subscribe', id: 's1', topic: 'np:daemon' }),
    },
    socket,
  );
  return socket;
}

interface Session {
  readonly app: StandaloneServer;
  readonly base: string;
  readonly apiKey: Record<string, string>;
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response>;
}

/** Starts the application, signs in the seeded administrator (config test value) and issues a daemon API key. */
async function openSession(): Promise<Session> {
  const app = await startApp();
  const base = `http://localhost${app.application.publicBasePath}/api`;
  const post = (url: string, body: unknown, headers: Record<string, string>) =>
    app.fetch(
      new Request(`${base}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    );
  const signIn = await post(
    '/auth/sign-in/username',
    { username: 'nocobase', password: 'admin123' },
    {},
  );
  expect(signIn.status).toBe(200);
  const cookie = cookiesOf(signIn);
  const created = await post(
    '/auth/api-key/create',
    { name: 'np-daemon-test' },
    { cookie },
  );
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  return { app, base, apiKey: { 'x-api-key': key }, post };
}

const REGISTER = {
  daemonId: 'daemon-auth-test',
  deviceName: 'ci',
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

describe('daemon authentication through the application', () => {
  it('resolves x-api-key to the key owner on the daemon API', async () => {
    const { app, base, apiKey, post } = await openSession();
    expect((await app.fetch(new Request(`${base}/np/me`))).status).toBe(401);
    const me = await app.fetch(
      new Request(`${base}/np/me`, { headers: apiKey }),
    );
    expect(me.status).toBe(200);
    const { data: identity } = (await me.json()) as {
      data: { userId: string; name: string };
    };
    expect(identity.userId).toBeTruthy();

    expect((await post('/np/daemon/register', REGISTER, apiKey)).status).toBe(
      200,
    );
    // A daemon newer than the server is registered but told it cannot work here (NP-150): never a bare 426.
    const tooNew = await post(
      '/np/daemon/register',
      { ...REGISTER, protocolVersion: 99, minProtocolVersion: 99 },
      apiKey,
    );
    expect(tooNew.status).toBe(200);
    await expect(tooNew.json()).resolves.toMatchObject({
      data: {
        compatibility: { status: 'unsupported', reason: 'daemonTooNew' },
      },
    });
    const compatibility = await app.fetch(
      new Request(`${base}/np/daemon/compatibility`, { headers: apiKey }),
    );
    expect(compatibility.status).toBe(200);
    await expect(compatibility.json()).resolves.toMatchObject({
      data: {
        latestVersion: LATEST_CLI_VERSION,
        downloadPath: `/assets/cli/nocoproject-cli-${LATEST_CLI_VERSION}.tgz`,
      },
    });
    expect(
      (await app.fetch(new Request(`${base}/np/daemon/compatibility`))).status,
    ).toBe(401);
    const unknown = await post(
      '/np/daemon/heartbeat',
      { daemonId: 'never-registered', runtimeIds: ['x'] },
      apiKey,
    );
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({
      code: 'RUNTIME_NOT_FOUND',
    });
  });

  it('lets the API key subscribe to np:daemon and wakes it when work is queued', async () => {
    const { app, apiKey, post } = await openSession();
    const registered = await post('/np/daemon/register', REGISTER, apiKey);
    const { data: registration } = (await registered.json()) as {
      data: { runtimes: { id: string }[] };
    };
    const runtimeId = registration.runtimes[0]!.id;

    // Anonymous sockets cannot subscribe to the user topic; the API key's socket can.
    const anonymous = await openSocket(app, {});
    expect(anonymous.messages[0]).toMatchObject({
      type: 'error',
      code: 'AUTHENTICATION_REQUIRED',
    });
    const daemon = await openSocket(app, apiKey);
    expect(daemon.messages[0]).toMatchObject({
      type: 'subscribed',
      topic: 'np:daemon',
    });

    // Writes use the key: cookie-authenticated writes also need a trusted Origin, which this in-process request lacks.
    const agent = await post(
      '/np/agents',
      {
        name: 'Echo',
        instructions: 'Echo.',
        runtimeId,
        provider: 'echo',
        capabilities: ['context.read', 'comment.create', 'issue.execute'],
      },
      apiKey,
    );
    expect(agent.status).toBe(201);
    const { data: agentBody } = (await agent.json()) as {
      data: { id: string };
    };
    const issue = await post(
      '/np/issues',
      { title: 'Wake', executor: { type: 'agent', id: agentBody.id } },
      apiKey,
    );
    expect(issue.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(daemon.messages).toContainEqual(
      expect.objectContaining({
        type: 'event',
        topic: 'np:daemon',
        payload: { kind: 'workAvailable', runtimeId },
      }),
    );
  });

  it('refuses a run token on the browser and daemon surfaces', async () => {
    const { app, base, post } = await openSession();
    const runToken = { authorization: `Bearer npr_${'c'.repeat(40)}` };
    expect(
      (await app.fetch(new Request(`${base}/np/issues`, { headers: runToken })))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          '/np/daemon/heartbeat',
          { daemonId: 'x', runtimeIds: [] },
          runToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          new Request(`${base}/np/agent/context`, { headers: runToken }),
        )
      ).status,
    ).toBe(401);
  });
});
