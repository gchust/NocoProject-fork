import { ApiClientError } from '@nocobase/app-client';
import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NpStartDialog } from '../../client/components/np-start-dialog.js';
import locales from '../../client/locales/index.js';
import { useBoardMove } from '../../client/pages/np/issues/board/use-board-move.js';
import IssuesPage from '../../client/pages/np/issues/index.js';
import { DEFAULT_STATUS_CATALOG } from '../../client/pages/np/constants.js';
import type { IssueListItem } from '../../client/pages/np/types.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const realtime = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
}));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));
vi.mock('@/components/ui/toast', () => ({ toast }));

const NOW = new Date().toISOString();

const AGENT_ISSUE: IssueListItem = {
  id: '201',
  identifier: 'NP-7',
  title: 'Parked work for the coder',
  statusKey: 'backlog',
  priority: 'medium',
  ownerUserId: 'u1',
  executorType: 'agent',
  executorId: 'a1',
  executorName: 'Claude Coder',
  revision: 4,
  autoExecuteSubtasks: false,
  updatedAt: NOW,
};
const PLAIN_ISSUE: IssueListItem = {
  ...AGENT_ISSUE,
  id: '202',
  identifier: 'NP-8',
  title: 'Write the docs',
  statusKey: 'todo',
  executorType: 'none',
  executorId: null,
  executorName: null,
};

async function renderWithProviders(element: ReactElement, entry: string) {
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
            <Route path='/issues' element={element} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/** Drives the board's move hook the way a drop does, without simulating pointer geometry jsdom lacks. */
function MoveHarness({
  issue,
  to,
}: {
  readonly issue: IssueListItem;
  readonly to: string;
}): ReactElement {
  const move = useBoardMove(DEFAULT_STATUS_CATALOG);
  return (
    <>
      <button type='button' onClick={() => move.drop(issue, to)}>
        drop
      </button>
      <output aria-label='pending'>{move.overrides.get(issue.id) ?? ''}</output>
      <NpStartDialog
        request={move.startRequest}
        onDecide={move.decide}
        onCancel={move.cancel}
      />
    </>
  );
}

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
});

describe('issue board', () => {
  it('shows a column per status with its cards, read from the board view', async () => {
    api.request.mockImplementation(
      (options: { path: string; query?: Record<string, unknown> }) => {
        if (options.path === 'np/me') {
          return Promise.resolve({ data: { userId: 'u1', name: 'Zhou' } });
        }
        if (options.path === 'np/issues' && options.query?.view === 'board') {
          return Promise.resolve({
            data: {
              groups: [
                { statusKey: 'backlog', issues: [AGENT_ISSUE] },
                { statusKey: 'todo', issues: [PLAIN_ISSUE] },
              ],
            },
          });
        }
        return Promise.resolve({ data: [] });
      },
    );
    await renderWithProviders(<IssuesPage />, '/issues?view=board&project=p1');

    const board = await screen.findByRole('region', { name: 'Issue board' });
    const backlog = within(board).getByRole('region', { name: /Backlog/ });
    expect(
      within(backlog).getByText('Parked work for the coder'),
    ).toBeVisible();
    expect(within(backlog).getByText('Claude Coder')).toBeVisible();
    const todo = within(board).getByRole('region', { name: /Todo/ });
    expect(within(todo).getByText('Write the docs')).toBeVisible();
    expect(within(board).getAllByText('No issues').length).toBeGreaterThan(0);
    // A card keeps native touch scrolling, so a swipe on it scrolls the column on a phone (NP-144).
    const card = within(todo).getByRole('button', { name: /Write the docs/ });
    expect(card).toHaveClass('touch-manipulation');
    expect(card).not.toHaveClass('touch-none');
    // The filter in the URL reaches the request.
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/issues',
        query: expect.objectContaining({ view: 'board', projectId: 'p1' }),
      }),
    );
  });

  it('is not draggable without issues/edit (NP-161)', async () => {
    api.request.mockImplementation(
      (options: { path: string; query?: Record<string, unknown> }) => {
        if (options.path === 'np/me') {
          return Promise.resolve({
            data: {
              userId: 'u1',
              name: 'Zhou',
              scopes: { 'nocoproject.issues/edit': 'none' },
            },
          });
        }
        if (options.path === 'np/issues' && options.query?.view === 'board') {
          return Promise.resolve({
            data: { groups: [{ statusKey: 'todo', issues: [PLAIN_ISSUE] }] },
          });
        }
        return Promise.resolve({ data: [] });
      },
    );
    await renderWithProviders(<IssuesPage />, '/issues?view=board');

    const board = await screen.findByRole('region', { name: 'Issue board' });
    // The card is not a drag handle: no role, no roledescription, no grab cursor.
    expect(
      within(board).queryByRole('button', { name: /Write the docs/ }),
    ).toBeNull();
    const card = within(board)
      .getByText('Write the docs')
      .closest('div')!.parentElement!;
    expect(card).not.toHaveClass('cursor-grab');
    expect(card).not.toHaveAttribute('aria-roledescription');
  });

  it('asks before a move starts the agent, and sends start: false for "Don\'t start now"', async () => {
    const user = userEvent.setup();
    api.request.mockResolvedValue({
      data: { ...AGENT_ISSUE, statusKey: 'todo' },
    });
    await renderWithProviders(
      <MoveHarness issue={AGENT_ISSUE} to='todo' />,
      '/issues',
    );

    await user.click(screen.getByRole('button', { name: 'drop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start now?' });
    expect(within(dialog).getByText('Claude Coder')).toBeVisible();
    // The card already sits in its target column while the dialog asks (the modal hides the rest from the tree).
    expect(
      screen.getByRole('status', { name: 'pending', hidden: true }),
    ).toHaveTextContent('todo');
    await user.click(within(dialog).getByRole('switch'));
    await user.click(
      within(dialog).getByRole('button', { name: "Don't start now" }),
    );

    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/201',
          method: 'PATCH',
          json: {
            statusKey: 'todo',
            start: false,
            autoExecuteSubtasks: true,
            revision: 4,
          },
        }),
      ),
    );
  });

  it('snaps a card back with a toast when the transition is rejected', async () => {
    const user = userEvent.setup();
    api.request.mockRejectedValue(
      new ApiClientError('nope', {
        status: 403,
        code: 'TRANSITION_NOT_ALLOWED',
        method: 'PATCH',
        url: '/api/np/issues/202',
      }),
    );
    await renderWithProviders(
      <MoveHarness issue={PLAIN_ISSUE} to='done' />,
      '/issues',
    );

    await user.click(screen.getByRole('button', { name: 'drop' }));
    // A plain move needs no confirmation.
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: 'NP-8 cannot move to that status.',
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'pending' })).toHaveTextContent(
        '',
      ),
    );
  });

  it('drops the move when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    await renderWithProviders(
      <MoveHarness issue={AGENT_ISSUE} to='in_progress' />,
      '/issues',
    );
    await user.click(screen.getByRole('button', { name: 'drop' }));
    await screen.findByRole('dialog', { name: 'Start now?' });
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'pending' })).toHaveTextContent(
        '',
      ),
    );
    expect(api.request).not.toHaveBeenCalled();
  });
});
