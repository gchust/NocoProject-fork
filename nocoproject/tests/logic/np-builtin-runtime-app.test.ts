// @vitest-environment node
/**
 * NP-219 built-in runtimes through the whole application (isolated SQLite) with the real AI plugin and its public
 * API only: the plugin's configured LLM services become candidates, enabling one runs the connectivity check through
 * the plugin's provider (here against a local OpenAI-compatible stub), a refusing service shows `check_failed`, and
 * without any configured service the candidates are empty (protocol-runtime-types.md §4.3).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startNpApp } from './np-app-harness.ts';
import { signIn, type Client } from './np-app-client.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `/ok/v1/chat/completions` answers like OpenAI; `/denied/v1/...` refuses the key. */
async function stubModels(): Promise<string> {
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.startsWith('/denied')) {
        response.statusCode = 401;
        response.end(
          JSON.stringify({
            error: {
              message: 'Incorrect API key provided',
              type: 'invalid_request_error',
            },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'stub-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function service(name: string, baseURL: string) {
  return {
    name,
    title: name === 'stub' ? 'Stub models' : 'Denied models',
    provider: 'openai-completions',
    options: { apiKey: 'test-key', baseURL },
    enabledModels: [{ label: 'Stub model', value: 'stub-model' }],
    overrideEnabledModels: true,
    enabled: true,
  };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function admin(llmServices: unknown[]): Promise<Client> {
  const app = await startNpApp(cleanups, 'nocoproject-builtin-', {
    config: { ai: { llmServices } },
  });
  return signIn(app, '/auth/sign-in/username', {
    username: 'nocobase',
    password: 'admin123',
  });
}

describe('built-in runtimes through the application', () => {
  it('enables a configured LLM service, checks it through the plugin and refuses deleting it while in use', async () => {
    const base = await stubModels();
    const client = await admin([
      service('stub', `${base}/ok/v1`),
      service('denied', `${base}/denied/v1`),
    ]);
    const candidates = await json<{
      data: { plugin: string; services: { llmService: string }[] };
    }>(await client.get('/np/runtimes/builtin/candidates'));
    expect(candidates.data.plugin).toBe('ready');
    expect(
      candidates.data.services.map((item) => item.llmService).sort(),
    ).toEqual(['denied', 'stub']);

    const enabled = await client.send('POST', '/np/runtimes/builtin', {
      llmService: 'stub',
    });
    expect(enabled.status).toBe(201);
    const { data: runtime } = await json<{
      data: {
        id: string;
        status: string;
        runtimeType: string;
        enabledModels: unknown[];
      };
    }>(enabled);
    expect(runtime).toMatchObject({
      runtimeType: 'builtin',
      status: 'online',
      enabledModels: [{ label: 'Stub model', value: 'stub-model' }],
    });
    expect(
      (
        await client.send('POST', '/np/runtimes/builtin', {
          llmService: 'stub',
        })
      ).status,
    ).toBe(409);

    const denied = await client.send('POST', '/np/runtimes/builtin', {
      llmService: 'denied',
    });
    const deniedBody = await json<{
      data: { id: string; status: string; statusReason: string };
      details?: { message: string };
    }>(denied);
    expect(deniedBody.data).toMatchObject({
      status: 'offline',
      statusReason: 'check_failed',
    });
    expect(deniedBody.details?.message).toBeTruthy();

    const listed = await json<{ data: { id: string; runtimeType: string }[] }>(
      await client.get('/np/runtimes?runtimeType=builtin'),
    );
    expect(listed.data.map((item) => item.id).sort()).toEqual(
      [runtime.id, deniedBody.data.id].sort(),
    );
    expect((await client.get('/np/runtimes?runtimeType=cloud')).status).toBe(
      400,
    );

    const agent = await client.send('POST', '/np/agents', {
      name: 'Helper',
      instructions: '',
      runtimeId: runtime.id,
      runtimeType: 'builtin',
      provider: 'nocobase-ai',
      model: 'stub-model',
      capabilities: ['context.read', 'comment.create'],
    });
    expect(agent.status).toBe(201);
    const inUse = await client.send('DELETE', `/np/runtimes/${runtime.id}`);
    expect(inUse.status).toBe(409);
    expect((await json<{ code: string }>(inUse)).code).toBe('RUNTIME_IN_USE');
    const removed = await client.send(
      'DELETE',
      `/np/runtimes/${deniedBody.data.id}`,
    );
    expect(removed.status).toBe(200);
  }, 60_000);

  it('offers no candidates without a configured LLM service', async () => {
    const client = await admin([]);
    const candidates = await json<{ data: unknown }>(
      await client.get('/np/runtimes/builtin/candidates'),
    );
    expect(candidates.data).toEqual({ plugin: 'ready', services: [] });
    const enabled = await client.send('POST', '/np/runtimes/builtin', {
      llmService: 'stub',
    });
    expect(enabled.status).toBe(400);
    expect((await json<{ code: string }>(enabled)).code).toBe(
      'INVALID_LLM_SERVICE',
    );
    // Creating an agent still needs a type.
    const untyped = await client.send('POST', '/np/agents', {
      name: 'X',
      instructions: '',
      runtimeId: 'none',
      provider: 'echo',
    });
    expect((await json<{ code: string }>(untyped)).code).toBe(
      'INVALID_RUNTIME_TYPE',
    );
  }, 60_000);
});
