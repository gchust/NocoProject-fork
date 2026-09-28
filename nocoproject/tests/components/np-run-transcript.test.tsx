import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import locales from '../../client/locales/index.js';
import RunTranscriptPage from '../../client/pages/np/issues/detail/transcript.js';

type Listener = (event: { payload: unknown }) => void;

const api = vi.hoisted(() => ({ request: vi.fn() }));
const realtime = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  subscribe: vi.fn(),
  onOpen: vi.fn(() => () => {}),
}));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));

const NOW = new Date().toISOString();

async function renderTranscript() {
  const runtime = new I18nRuntime({
    defaultLocale: 'en-US',
    locales: ['en-US', 'zh-CN'],
    applicationNamespace: 'test-app',
  });
  runtime.registerApplicationNamespace('test-app', locales);
  await runtime.init('en-US');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <I18nProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/issues/101/runs/run-1']}>
          <Routes>
            <Route
              path='/issues/:issueId/runs/:runId'
              element={<RunTranscriptPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  api.request.mockReset();
  realtime.listeners.clear();
});

describe('run transcript', () => {
  it('loads the transcript, then fetches only newer events when the run topic signals', async () => {
    realtime.subscribe.mockImplementation(
      (topic: string, listener: Listener) => {
        realtime.listeners.set(topic, listener);
        return () => realtime.listeners.delete(topic);
      },
    );
    api.request.mockImplementation(
      (options: { path: string; query?: { since?: number } }) => {
        if (options.path === 'np/runs/run-1') {
          return Promise.resolve({
            data: {
              id: 'run-1',
              agentId: 'a1',
              agentName: 'Claude Coder',
              status: 'completed',
              triggerType: 'assign',
              createdAt: NOW,
            },
          });
        }
        if (options.path === 'np/agents') return Promise.resolve({ data: [] });
        if (options.path === 'np/runs/run-1/events') {
          return Promise.resolve(
            options.query?.since === undefined
              ? {
                  data: [
                    {
                      seq: 1,
                      type: 'text',
                      content: 'Reading the issue',
                      at: NOW,
                    },
                    {
                      seq: 2,
                      type: 'toolUse',
                      tool: 'Bash',
                      input: { command: 'nocoproject issue get NP-1' },
                      at: NOW,
                    },
                  ],
                  last: 2,
                }
              : {
                  data: [
                    { seq: 3, type: 'error', content: 'Tool crashed', at: NOW },
                  ],
                  last: 3,
                },
          );
        }
        return Promise.reject(new Error(`unexpected ${options.path}`));
      },
    );

    await renderTranscript();

    expect(await screen.findByText('Reading the issue')).toBeVisible();
    expect(screen.getByText('Bash')).toBeVisible();
    // The command is readable without expanding the tool call (iteration 1 §J 7).
    expect(screen.getByText('$ nocoproject issue get NP-1')).toBeVisible();
    expect(screen.getByText('Claude Coder')).toBeVisible();

    const listener = realtime.listeners.get('np:run:run-1');
    expect(listener).toBeDefined();
    act(() => listener?.({ payload: { kind: 'run.events', last: 3 } }));

    expect(await screen.findByText('Tool crashed')).toBeVisible();
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/runs/run-1/events',
          query: { since: 2 },
        }),
      ),
    );
  });
});
