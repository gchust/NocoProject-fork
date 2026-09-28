import './np-editor-dom.js';

import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PmPage from '../../client/pages/np/pm/index.js';
import { type RequestOptions, renderNp } from './np-harness.js';

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

const CONVERSATION = {
  issue: {
    id: 'pm-issue',
    identifier: 'NP-90',
    title: '项目经理 · Zhou',
    description: null,
    statusKey: 'todo',
    priority: 'none',
    ownerUserId: 'u1',
    executorType: 'agent',
    executorId: 'pm',
    executorName: 'Project Manager',
    executionMode: 'session',
    originType: 'pm',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
  comments: [
    {
      id: 'q1',
      authorType: 'user',
      authorId: 'u1',
      authorName: 'Zhou',
      content: 'What shipped this week?',
      parentId: null,
      createdAt: NOW,
    },
    {
      id: 'a1',
      authorType: 'agent',
      authorId: 'pm',
      authorName: 'Project Manager',
      content: 'NP-12 and NP-14 were accepted.',
      parentId: null,
      createdAt: NOW,
    },
  ],
  activities: [],
  runs: [],
};

function respond(
  settings: Record<string, unknown>,
  conversation: (options: RequestOptions) => unknown,
) {
  return (options: RequestOptions): Promise<unknown> => {
    switch (options.path) {
      case 'np/settings':
        return Promise.resolve({ data: settings });
      case 'np/pm/conversation':
        try {
          return Promise.resolve(conversation(options));
        } catch (error) {
          return Promise.reject(error);
        }
      case 'np/issues/pm-issue':
        return Promise.resolve({ data: CONVERSATION });
      case 'np/agents':
        return Promise.resolve({
          data: [
            {
              id: 'pm',
              name: 'Project Manager',
              runtimeId: 'r1',
              provider: 'opencode',
              kind: 'manager',
            },
          ],
        });
      default:
        return Promise.resolve({ data: [] });
    }
  };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  api.request.mockReset();
  vi.unstubAllGlobals();
});

describe('project manager page (iteration 4 §C)', () => {
  it('points to the settings while no project manager is chosen', async () => {
    api.request.mockImplementation(
      respond({ pmAgentId: null }, () => ({ data: { issueId: 'x' } })),
    );
    await renderNp(<PmPage />, { url: '/pm', path: '/pm' });
    expect(await screen.findByText('No project manager yet')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Open settings' }),
    ).toHaveAttribute('href', '/config/general');
    expect(api.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'np/pm/conversation' }),
    );
  });

  it('shows the empty state when the server refuses for lack of a project manager', async () => {
    api.request.mockImplementation(
      respond({ canEdit: false }, () => {
        throw new ApiClientError('none', {
          status: 409,
          code: 'PM_NOT_CONFIGURED',
          method: 'GET',
          url: '/api/np/pm/conversation',
        });
      }),
    );
    await renderNp(<PmPage />, { url: '/pm', path: '/pm' });
    expect(await screen.findByText('No project manager yet')).toBeVisible();
  });

  it('opens the conversation full width with its messages and composer', async () => {
    const calls: string[] = [];
    api.request.mockImplementation(
      respond({ pmAgentId: 'pm' }, (options) => {
        calls.push(options.method ?? 'GET');
        // No conversation yet: GET finds none, POST creates it.
        return options.method === 'POST'
          ? { data: { issueId: 'pm-issue' } }
          : { data: { issueId: null } };
      }),
    );
    await renderNp(<PmPage />, { url: '/pm', path: '/pm' });
    expect(
      await screen.findByText('NP-12 and NP-14 were accepted.'),
    ).toBeVisible();
    expect(screen.getByText('What shipped this week?')).toBeVisible();
    expect(calls).toEqual(['GET', 'POST']);
    expect(
      screen.getByRole('heading', { name: 'Project manager' }),
    ).toBeVisible();
    // Full width: no properties column beside the conversation.
    expect(screen.queryByRole('complementary')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('np-session-panel')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-placeholder="Ask the project manager…"]'),
      ).not.toBeNull(),
    );
  });
});
