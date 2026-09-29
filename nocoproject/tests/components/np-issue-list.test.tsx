import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import locales from '../../client/locales/index.js';
import IssuesPage from '../../client/pages/np/issues/index.js';
import type { IssueListItem } from '../../client/pages/np/types.js';

// One shared client for the whole file: a new object per call would make effects that depend on it re-run forever.
const api = vi.hoisted(() => ({ request: vi.fn() }));
const realtime = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
}));

vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));

/** `np/me` answered for every test here: a plain member, full `issues/edit` unless `scopes` overrides it. */
function withMe(
  fallback: (options: {
    path: string;
    query?: Record<string, unknown>;
  }) => unknown,
  scopes?: Record<string, string>,
): (options: { path: string; query?: Record<string, unknown> }) => unknown {
  return (options) =>
    options.path === 'np/me'
      ? { data: { userId: 'u1', name: 'Zhou', scopes } }
      : fallback(options);
}

const ISSUES: IssueListItem[] = [
  {
    id: '101',
    number: 1,
    identifier: 'NP-1',
    title: 'Wire up the claim endpoint',
    statusKey: 'in_progress',
    priority: 'high',
    ownerUserId: 'u1',
    ownerName: 'Zhou',
    executorType: 'agent',
    executorId: 'a1',
    executorName: 'Claude Coder',
    activeRunCount: 1,
    updatedAt: new Date().toISOString(),
  },
  {
    id: '102',
    number: 2,
    identifier: 'NP-2',
    title: 'Write the protocol doc',
    statusKey: 'todo',
    priority: 'none',
    ownerUserId: 'u1',
    ownerName: 'Zhou',
    executorType: 'user',
    executorId: 'u2',
    executorName: 'Ada',
    activeRunCount: 0,
    updatedAt: new Date().toISOString(),
  },
];

async function renderPage(entry = '/issues?view=list') {
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
  return render(
    <I18nProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path='/issues' element={<IssuesPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  api.request.mockReset();
  realtime.subscribe.mockClear();
});

describe('issue list', () => {
  it('renders a row per issue with status, owner and executor', async () => {
    api.request.mockImplementation(withMe(() => ({ data: ISSUES })));
    await renderPage();

    const firstRow = (
      await screen.findByText('Wire up the claim endpoint')
    ).closest('tr') as HTMLElement;
    expect(within(firstRow).getByRole('link', { name: 'NP-1' })).toBeVisible();
    expect(within(firstRow).getByText('In progress')).toBeVisible();
    expect(within(firstRow).getByText('High')).toBeVisible();
    expect(within(firstRow).getByText('Zhou')).toBeVisible();
    expect(within(firstRow).getByText('Claude Coder')).toBeVisible();

    const secondRow = screen
      .getByText('Write the protocol doc')
      .closest('tr') as HTMLElement;
    expect(within(secondRow).getByText('Todo')).toBeVisible();
    expect(within(secondRow).getByText('Ada')).toBeVisible();

    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'np/issues' }),
    );
  });

  it('hides "New issue" without issues/edit (NP-161)', async () => {
    api.request.mockImplementation(
      withMe(() => ({ data: ISSUES }), { 'nocoproject.issues/edit': 'none' }),
    );
    await renderPage();

    await screen.findByText('Wire up the claim endpoint');
    expect(screen.queryByRole('button', { name: /New issue/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /New issue/ })).toBeNull();
  });

  it('marks agent executors and shows a working indicator while a run is active', async () => {
    api.request.mockImplementation(withMe(() => ({ data: ISSUES })));
    await renderPage();

    const agentRow = (await screen.findByText('Claude Coder')).closest(
      'tr',
    ) as HTMLElement;
    expect(within(agentRow).getByText('Agent')).toBeVisible();
    expect(within(agentRow).getByText('Working')).toBeVisible();

    const personRow = screen.getByText('Ada').closest('tr') as HTMLElement;
    expect(within(personRow).queryByText('Agent')).toBeNull();
    expect(within(personRow).queryByText('Working')).toBeNull();
  });

  it('subscribes to issue and agent invalidation topics', async () => {
    api.request.mockImplementation(withMe(() => ({ data: ISSUES })));
    await renderPage();
    await screen.findByText('Wire up the claim endpoint');
    const topics = realtime.subscribe.mock.calls.map((call) => call[0]);
    expect(topics).toEqual(expect.arrayContaining(['np:issues', 'np:agents']));
  });

  it('shows the empty state when there are no issues', async () => {
    api.request.mockImplementation(withMe(() => ({ data: [] })));
    await renderPage();
    expect(await screen.findByText('No issues yet')).toBeVisible();
  });

  it('reads the search and status filter from the URL and sends them', async () => {
    api.request.mockImplementation(
      withMe((options) => ({
        data: options.path === 'np/issues' ? ISSUES : [],
      })),
    );
    await renderPage('/issues?view=list&q=claim&status=in_progress');

    await screen.findByText('Wire up the claim endpoint');
    expect(screen.getByRole('textbox', { name: 'Search issues' })).toHaveValue(
      'claim',
    );
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/issues',
        query: expect.objectContaining({
          q: 'claim',
          statusKey: 'in_progress',
        }),
      }),
    );
    // A filtered result offers to clear the filters; the table has no row selection to count.
    expect(screen.getByRole('button', { name: /Clear filters/ })).toBeVisible();
    expect(screen.queryByText(/row\(s\) selected/)).toBeNull();
  });

  it('opens on the board by default and remembers the list once chosen', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    api.request.mockImplementation(
      withMe((options) =>
        options.query?.view === 'board'
          ? { data: { groups: [{ statusKey: 'todo', issues: [ISSUES[1]] }] } }
          : { data: options.path === 'np/issues' ? ISSUES : [] },
      ),
    );
    const view = await renderPage('/issues');
    expect(
      await screen.findByRole('region', { name: 'Issue board' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByText('Wire up the claim endpoint')).toBeVisible();
    expect(localStorage.getItem('nocoproject:issues-view:issues')).toBe('list');
    view.unmount();

    // Back on the page without `?view=`: the list is remembered.
    await renderPage('/issues');
    expect(await screen.findByRole('table')).toBeVisible();
    localStorage.clear();
  });

  it('switches to the board view', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      withMe((options) =>
        options.query?.view === 'board'
          ? { data: { groups: [{ statusKey: 'todo', issues: [ISSUES[1]] }] } }
          : { data: options.path === 'np/issues' ? ISSUES : [] },
      ),
    );
    await renderPage();
    await screen.findByText('Wire up the claim endpoint');

    await user.click(screen.getByRole('button', { name: 'Board' }));
    expect(
      await screen.findByRole('region', { name: 'Issue board' }),
    ).toBeVisible();
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/issues',
        query: expect.objectContaining({ view: 'board' }),
      }),
    );
  });

  it('offers a retry when loading fails', async () => {
    api.request.mockRejectedValue(new Error('offline'));
    await renderPage();
    expect(await screen.findByText('Unable to load issues')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
