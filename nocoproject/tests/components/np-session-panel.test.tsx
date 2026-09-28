import './np-editor-dom.js';

import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeIssueDetail } from '../../client/pages/np/detail-normalize.js';
import { SessionPanel } from '../../client/pages/np/issues/detail/session-panel.js';
import { answer, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const realtime = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
}));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));

const NOW = new Date().toISOString();

function detail(extra: Record<string, unknown>) {
  return normalizeIssueDetail({
    issue: {
      id: '101',
      identifier: 'NP-1',
      title: 'Chat',
      statusKey: 'in_progress',
      priority: 'none',
      ownerUserId: 'u1',
      executorType: 'agent',
      executorId: 'a1',
      description: null,
      revision: 1,
      executionMode: 'session',
      createdAt: NOW,
      updatedAt: NOW,
    },
    comments: [
      {
        id: 'c1',
        authorType: 'user',
        authorId: 'u1',
        authorName: 'Zhou',
        content: 'Rename the flag',
        parentId: null,
        createdAt: NOW,
      },
      {
        id: 'c2',
        authorType: 'agent',
        authorId: 'a1',
        content: 'Renamed it.',
        parentId: null,
        createdAt: NOW,
      },
    ],
    ...extra,
  });
}

const AGENTS = [
  {
    id: 'a1',
    name: 'Claude Coder',
    runtimeId: 'r1',
    runtimeStatus: 'online' as const,
    provider: 'claude',
  },
];

afterEach(() => {
  api.request.mockReset();
  realtime.subscribe.mockClear();
});

describe('session panel', () => {
  it('shows the conversation and "sent after this turn (N queued)" while the agent works', async () => {
    api.request.mockImplementation(
      answer({
        'GET np/members': { data: [] },
        'GET np/runs/r1/events': {
          data: [
            { seq: 1, type: 'text', content: 'Looking at the flag', at: NOW },
          ],
          last: 1,
        },
      }),
    );
    await renderNp(
      <SessionPanel
        detail={detail({
          runs: [
            {
              id: 'r1',
              agentId: 'a1',
              status: 'running',
              createdAt: NOW,
              startedAt: NOW,
            },
          ],
          queuedRun: { id: 'r2', triggerCount: 2 },
        })}
        agents={AGENTS}
      />,
    );
    const panel = screen.getByTestId('np-session-panel');
    expect(panel).toHaveTextContent('Rename the flag');
    expect(panel).toHaveTextContent('Renamed it.');
    expect(screen.getByText('Claude Coder is working')).toBeInTheDocument();
    expect(screen.getByTestId('np-session-hint')).toHaveTextContent(
      'Will be sent after this turn (2 queued).',
    );
    expect(await screen.findByText('Looking at the flag')).toBeInTheDocument();
    expect(realtime.subscribe).toHaveBeenCalledWith(
      'np:run:r1',
      expect.any(Function),
    );
    expect(
      screen.getByRole('textbox', { name: 'Comment' }),
    ).toBeInTheDocument();
  });

  it('says new messages wait for the turn when nothing is queued, and nothing when idle', async () => {
    api.request.mockImplementation(
      answer({
        'GET np/members': { data: [] },
        'GET np/runs/r1/events': { data: [], last: null },
      }),
    );
    const view = await renderNp(
      <SessionPanel
        detail={detail({
          runs: [
            { id: 'r1', agentId: 'a1', status: 'dispatched', createdAt: NOW },
          ],
        })}
        agents={AGENTS}
      />,
    );
    expect(screen.getByTestId('np-session-hint')).toHaveTextContent(
      'The agent is working. New messages are sent after this turn.',
    );
    view.unmount();

    await renderNp(
      <SessionPanel
        detail={detail({
          runs: [
            { id: 'r0', agentId: 'a1', status: 'completed', createdAt: NOW },
          ],
        })}
        agents={AGENTS}
      />,
    );
    expect(screen.queryByTestId('np-session-hint')).toBeNull();
  });
});
