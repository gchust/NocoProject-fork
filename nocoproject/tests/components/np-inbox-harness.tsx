import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

import locales from '../../client/locales/index.js';
import InboxPage from '../../client/pages/np/inbox/index.js';
import type { InboxItem } from '../../client/pages/np/types.js';

/** Fixtures and rendering shared by the inbox tests (`np-inbox*.test.tsx`); each file installs its own mocks. */

export const NOW = new Date().toISOString();

export function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: 'n1',
    kind: 'decision',
    type: 'review_requested',
    issueId: '101',
    issueIdentifier: 'NP-1',
    title: 'NP-1 is ready for review',
    body: 'Claude Coder moved it to in review.',
    actorType: 'agent',
    actorName: 'Claude Coder',
    count: 1,
    readAt: null,
    archivedAt: null,
    resolvedAt: null,
    payload: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export const DECISIONS = [
  item({}),
  item({
    id: 'n2',
    type: 'proposal_pending',
    issueId: '102',
    issueIdentifier: 'NP-2',
    title: 'Executor proposals on NP-2',
    count: 3,
    readAt: NOW,
  }),
];
export const INFO = [
  item({
    id: 'n3',
    kind: 'info',
    type: 'commented',
    title: 'New comment on NP-1',
  }),
];

export const DETAIL = {
  issue: {
    id: '101',
    identifier: 'NP-1',
    title: 'Ship the claim endpoint',
    statusKey: 'in_review',
    priority: 'high',
    ownerUserId: 'u1',
    ownerName: 'Zhou',
    executorType: 'agent',
    executorId: 'a1',
    executorName: 'Claude Coder',
    description: null,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  },
  comments: [
    {
      id: 'c1',
      authorType: 'agent',
      authorId: 'a1',
      authorName: 'Claude Coder',
      content: 'Implemented the endpoint and added tests.',
      parentId: null,
      createdAt: NOW,
    },
  ],
  activities: [
    {
      id: 'act1',
      actorType: 'agent',
      actorId: 'a1',
      actorName: 'Claude Coder',
      action: 'status_changed',
      details: { from: 'in_progress', to: 'in_review' },
      createdAt: NOW,
    },
  ],
  runs: [],
};

export function respond(options: {
  path: string;
  method?: string;
  query?: Record<string, string>;
}) {
  if (options.path === 'np/inbox') {
    return Promise.resolve({
      data: options.query?.kind === 'info' ? INFO : DECISIONS,
      unread: { decision: 1, info: 4 },
    });
  }
  // Both decisions wait, one of them already read (NP-180: the decision tab counts pending, not unread).
  if (options.path === 'np/inbox/pending-count') {
    return Promise.resolve({ data: { decision: 2 } });
  }
  if (options.path === 'np/inbox/unread-count') {
    return Promise.resolve({ data: { decision: 1, info: 4 } });
  }
  if (options.path === 'np/issues/101' && !options.method) {
    return Promise.resolve({ data: DETAIL });
  }
  if (options.method === 'POST') return Promise.resolve({ data: {} });
  return Promise.reject(new Error(`unexpected ${options.path}`));
}

/** Answers `np/inbox` with `items` for decisions (and nothing for notifications), the rest as `respond`. */
export function withDecisions(items: InboxItem[]) {
  return (options: {
    path: string;
    method?: string;
    query?: Record<string, string>;
  }) =>
    options.path === 'np/inbox'
      ? Promise.resolve({
          data: options.query?.kind === 'info' ? [] : items,
        })
      : respond(options);
}

/** The inbox list's group of that name, and the detail pane. */
export const group = (name: string) => screen.getByRole('list', { name });
export const pane = () => screen.getByTestId('np-inbox-detail');

export async function renderInbox(entry = '/inbox') {
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
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path='/inbox' element={<InboxPage />} />
            <Route path='/issues/:issueId' element={<p>issue page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
