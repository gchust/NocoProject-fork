import './np-editor-dom.js';

import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import locales from '../../client/locales/index.js';
import IssueDetailPage from '../../client/pages/np/issues/detail/index.js';

/**
 * The issue page's "等你决定" section and live run indicator (nocosolution/frontend/nocosolution-frontend-standard.md §3): an open decision is
 * shown with the thing being decided in full and its actions right under it; deciding folds the card into a line.
 */

const api = vi.hoisted(() => ({ request: vi.fn() }));
const realtime = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
}));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));

const NOW = new Date().toISOString();

const DETAIL = {
  issue: {
    id: '101',
    number: 1,
    identifier: 'NP-1',
    title: 'Wire up the claim endpoint',
    description: null,
    statusKey: 'in_review',
    priority: 'high',
    ownerUserId: 'u1',
    ownerName: 'Zhou',
    executorType: 'agent',
    executorId: 'a1',
    executorName: 'Claude Coder',
    activeRunCount: 1,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  },
  comments: [
    {
      id: 'c9',
      authorType: 'agent',
      authorId: 'a1',
      authorName: 'Claude Coder',
      content: 'Delivered: the endpoint claims with SKIP LOCKED.',
      parentId: null,
      createdAt: NOW,
    },
  ],
  activities: [],
  runs: [
    {
      id: 'run-2',
      agentId: 'a1',
      agentName: 'Claude Coder',
      status: 'running',
      createdAt: NOW,
      startedAt: NOW,
    },
  ],
};

const REVIEW = {
  id: 'n1',
  kind: 'decision',
  type: 'review_requested',
  issueId: '101',
  issueIdentifier: 'NP-1',
  title: 'NP-1 Wire up the claim endpoint',
  body: 'The agent delivered and asks for review.',
  actorType: 'agent',
  actorName: 'Claude Coder',
  count: 1,
  readAt: null,
  archivedAt: null,
  resolvedAt: null,
  payload: {
    from: 'in_progress',
    to: 'in_review',
    actions: [
      {
        key: 'accept',
        label: 'np.inboxActions.accept',
        kind: 'primary',
        method: 'POST',
        path: '/np/issues/101/deliveries/accept',
      },
      {
        key: 'requestChanges',
        label: 'np.inboxActions.requestChanges',
        kind: 'secondary',
        method: 'POST',
        path: '/np/issues/101/deliveries/request-changes',
        needsComment: true,
      },
      {
        key: 'open',
        label: 'np.inboxActions.open',
        kind: 'secondary',
        opensIssue: true,
      },
    ],
  },
  createdAt: NOW,
  updatedAt: NOW,
};

let decisions: unknown[] = [];

function respond(options: {
  path: string;
  method?: string;
  query?: Record<string, string>;
}) {
  if (options.path === 'np/issues/101' && !options.method) {
    return Promise.resolve({ data: DETAIL });
  }
  if (options.path === 'np/inbox') {
    return Promise.resolve({ data: decisions });
  }
  if (options.path === 'np/issues/101/deliveries/accept') {
    decisions = [];
    return Promise.resolve({ data: {} });
  }
  if (options.path === 'np/agents') return Promise.resolve({ data: [] });
  if (options.path === 'np/me') {
    return Promise.resolve({ data: { userId: 'u1', name: 'Zhou' } });
  }
  return Promise.reject(new Error(`unexpected ${options.path}`));
}

async function renderDetail() {
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
        <MemoryRouter initialEntries={['/issues/101']}>
          <Routes>
            <Route path='/issues/:issueId' element={<IssueDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 500);
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  api.request.mockImplementation(respond);
});

afterEach(() => {
  vi.unstubAllGlobals();
  api.request.mockReset();
  toast.add.mockReset();
  decisions = [];
});

describe('issue page decisions', () => {
  it('shows the open decision with the delivery in full and decides it in place', async () => {
    decisions = [REVIEW];
    const user = userEvent.setup();
    await renderDetail();

    const section = await screen.findByRole('region', {
      name: /Waiting for you/,
    });
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/inbox',
        query: expect.objectContaining({
          kind: 'decision',
          resolved: 'false',
          issueId: '101',
        }),
      }),
    );
    const card = within(section).getByRole('article', {
      name: 'Delivery to accept',
    });
    expect(
      within(card).getByText(
        'Delivered: the endpoint claims with SKIP LOCKED.',
      ),
    ).toBeVisible();
    // On the issue page "open the issue" is not offered; the inbox link is.
    expect(within(card).queryByRole('button', { name: 'Open' })).toBeNull();
    expect(
      within(card).getByRole('link', { name: 'View in inbox' }),
    ).toHaveAttribute('href', '/inbox?item=n1');

    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/101/deliveries/accept',
          method: 'POST',
        }),
      ),
    );
    expect(await within(section).findByText('Accept — done')).toBeVisible();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
  });

  it('shows who is working now and no decision section when nothing waits', async () => {
    await renderDetail();

    expect(
      await screen.findByText('Claude Coder is working · 0 min'),
    ).toBeVisible();
    expect(screen.getByTestId('np-live-run')).toHaveAttribute(
      'href',
      '/issues/101/runs/run-2',
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'np/inbox' }),
      ),
    );
    expect(
      screen.queryByRole('region', { name: /Waiting for you/ }),
    ).toBeNull();
  });
});
