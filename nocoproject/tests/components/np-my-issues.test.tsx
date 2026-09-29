import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, useLocation } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ApprovalsRedirect from '../../client/pages/np/inbox/approvals.js';
import IntakeRedirect from '../../client/pages/np/intake/redirect.js';
import MyIssuesPage from '../../client/pages/np/my-issues/index.js';
import MyExecutingIssues from '../../client/pages/np/my-issues/executing.js';
import MyOwnedIssues from '../../client/pages/np/my-issues/owned.js';
import UsageRedirect from '../../client/pages/np/reports/usage-redirect.js';
import type { IssueListItem } from '../../client/pages/np/types.js';
import { type RequestOptions, renderNpRoutes } from './np-harness.js';

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

const MINE: IssueListItem = {
  id: '301',
  identifier: 'NP-301',
  title: 'Review the release notes',
  statusKey: 'todo',
  priority: 'none',
  ownerUserId: 'u1',
  ownerName: 'Zhou',
  executorType: 'user',
  executorId: 'u1',
  executorName: 'Zhou',
  updatedAt: new Date().toISOString(),
};

/** Prints where a redirect landed. */
function SearchProbe(): ReactElement {
  const location = useLocation();
  return <p data-testid='search'>{location.search}</p>;
}

function respond(options: RequestOptions): Promise<unknown> {
  switch (options.path) {
    case 'np/me':
      return Promise.resolve({ data: { userId: 'u1', name: 'Zhou' } });
    case 'np/issues':
      return Promise.resolve({ data: [MINE], nextCursor: null });
    case 'np/members':
      return Promise.resolve({
        data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'member' }],
      });
    default:
      return Promise.resolve({ data: [] });
  }
}

afterEach(() => api.request.mockReset());

function issuesQueries(): Record<string, unknown>[] {
  return api.request.mock.calls
    .map(([options]) => options as RequestOptions)
    .filter((options) => options.path === 'np/issues')
    .map((options) => options.query ?? {});
}

describe('my issues (§G)', () => {
  it('opens "I own" by default, filtered to the viewer, with the owner filter hidden', async () => {
    api.request.mockImplementation(respond);
    await renderNpRoutes(
      <Route path='/my-issues' element={<MyIssuesPage />}>
        <Route path='owned' element={<MyOwnedIssues />} />
        <Route path='executing' element={<MyExecutingIssues />} />
      </Route>,
      { url: '/my-issues?view=list' },
    );

    expect(await screen.findByText('Review the release notes')).toBeVisible();
    expect(screen.getByRole('link', { name: 'I own' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(issuesQueries().at(-1)).toMatchObject({ ownerUserId: 'u1' });
    expect(screen.queryByLabelText('Filter by owner')).toBeNull();
    expect(screen.getByLabelText('Filter by executor')).toBeVisible();
    // Rows open the issue on the issue page, not beside this one.
    expect(screen.getByRole('link', { name: 'NP-301' })).toHaveAttribute(
      'href',
      '/issues/301',
    );
  });

  it('switches to "I execute", which filters by executor instead', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(respond);
    await renderNpRoutes(
      <Route path='/my-issues' element={<MyIssuesPage />}>
        <Route path='owned' element={<MyOwnedIssues />} />
        <Route path='executing' element={<MyExecutingIssues />} />
      </Route>,
      { url: '/my-issues/owned?view=board' },
    );
    await screen.findByRole('link', { name: 'I execute' });
    await user.click(screen.getByRole('link', { name: 'I execute' }));
    await waitFor(() =>
      expect(issuesQueries().at(-1)).toMatchObject({
        executorId: 'u1',
        view: 'board',
      }),
    );
    expect(issuesQueries().at(-1)).not.toHaveProperty('ownerUserId', 'u1');
  });
});

describe('redirects kept for old links (§G)', () => {
  it('sends /intake to the AI tab of the new issue dialog, keeping the project and the batch', async () => {
    await renderNpRoutes(
      <>
        <Route path='/intake' element={<IntakeRedirect />} />
        <Route path='/issues/new' element={<SearchProbe />} />
      </>,
      { url: '/intake?project=p1&batch=b1' },
    );
    expect(await screen.findByTestId('search')).toHaveTextContent(
      '?tab=ai&project=p1&batch=b1',
    );
  });

  it('sends /inbox/approvals to the decisions list', async () => {
    await renderNpRoutes(
      <>
        <Route path='/inbox/approvals' element={<ApprovalsRedirect />} />
        <Route path='/inbox' element={<p>inbox</p>} />
      </>,
      { url: '/inbox/approvals' },
    );
    expect(await screen.findByText('inbox')).toBeVisible();
  });

  it('keeps the range when /usage moves to the reports tab', async () => {
    await renderNpRoutes(
      <>
        <Route path='/usage' element={<UsageRedirect />} />
        <Route path='/reports/usage' element={<p>usage tab</p>} />
      </>,
      { url: '/usage?from=2026-09-01' },
    );
    expect(await screen.findByText('usage tab')).toBeVisible();
  });
});
