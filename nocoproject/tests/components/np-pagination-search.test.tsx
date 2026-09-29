import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NpShortcuts } from '../../client/components/np-shortcuts.js';
import { NpVirtualList } from '../../client/components/np-virtual-list.js';
import IssuesPage from '../../client/pages/np/issues/index.js';
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

afterEach(() => api.request.mockReset());

/** `np/me` answered for every `IssuesPage` render here: a plain member, full `issues/edit`. */
function withMe(
  fallback: (options: RequestOptions) => unknown,
): (options: RequestOptions) => unknown {
  return (options) =>
    options.path === 'np/me'
      ? { data: { userId: 'u1', name: 'Zhou' } }
      : fallback(options);
}

function issue(id: string, statusKey = 'todo'): IssueListItem {
  return {
    id,
    identifier: `NP-${id}`,
    title: `Issue number ${id}`,
    statusKey,
    priority: 'none',
    ownerUserId: null,
    executorType: 'none',
    executorId: null,
    updatedAt: new Date().toISOString(),
  };
}

describe('issue list pages (§D)', () => {
  it('loads the next cursor page on "Load more" and appends it', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      withMe((options) => {
        if (options.path !== 'np/issues') return { data: [] };
        return options.query?.cursor === 'c2'
          ? { data: [issue('3')], nextCursor: null }
          : { data: [issue('1'), issue('2')], nextCursor: 'c2' };
      }),
    );
    await renderNpRoutes(<Route path='/issues' element={<IssuesPage />} />, {
      url: '/issues?view=list',
    });

    expect(await screen.findByText('Issue number 2')).toBeVisible();
    expect(screen.getByText('Showing 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Issue number 3')).toBeVisible();
    expect(screen.getByText('Showing 3')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/issues',
        query: expect.objectContaining({ cursor: 'c2', limit: 50 }),
      }),
    );
  });

  it('loads more cards into one board column', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      withMe((options) => {
        if (options.path !== 'np/issues') return { data: [] };
        if (options.query?.statusKey === 'todo') {
          return {
            data: {
              groups: [
                {
                  statusKey: 'todo',
                  issues: [issue('5')],
                  hasMore: false,
                  nextCursor: null,
                },
              ],
            },
          };
        }
        return {
          data: {
            groups: [
              {
                statusKey: 'todo',
                issues: [issue('4')],
                hasMore: true,
                nextCursor: 't2',
              },
            ],
          },
        };
      }),
    );
    await renderNpRoutes(<Route path='/issues' element={<IssuesPage />} />, {
      url: '/issues?view=board',
    });
    const todo = await screen.findByRole('region', { name: /Todo/u });
    expect(within(todo).getByText('Issue number 4')).toBeVisible();
    await user.click(within(todo).getByRole('button', { name: 'Load more' }));
    expect(await within(todo).findByText('Issue number 5')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          view: 'board',
          statusKey: 'todo',
          cursor: 't2',
        }),
      }),
    );
    await waitFor(() =>
      expect(
        within(todo).queryByRole('button', { name: 'Load more' }),
      ).toBeNull(),
    );
  });
});

describe('long lists (§H 8)', () => {
  it('renders short lists whole and long ones as a window', () => {
    const items = Array.from({ length: 150 }, (_, index) => `item-${index}`);
    const { rerender } = render(
      <NpVirtualList
        items={items.slice(0, 20)}
        itemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(20);

    rerender(
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 400, itemHeight: 40 }}
      >
        <NpVirtualList
          items={items}
          itemKey={(item) => item}
          renderItem={(item) => <span>{item}</span>}
        />
      </VirtuosoMockContext.Provider>,
    );
    const rendered = screen.getAllByRole('listitem').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(150);
    expect(screen.getByText('item-0')).toBeInTheDocument();
    expect(screen.queryByText('item-149')).toBeNull();
  });
});

describe('long issue tables (§H 8)', () => {
  it('virtualizes the issue table past 200 rows', async () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      issue(String(index)),
    );
    api.request.mockImplementation(
      withMe((options) =>
        options.path === 'np/issues'
          ? { data: many, nextCursor: null }
          : { data: [] },
      ),
    );
    const { container } = await renderNpRoutes(
      <Route
        path='/issues'
        element={
          <VirtuosoMockContext.Provider
            value={{ viewportHeight: 600, itemHeight: 40 }}
          >
            <IssuesPage />
          </VirtuosoMockContext.Provider>
        }
      />,
      { url: '/issues?view=list' },
    );
    expect(await screen.findByText('Showing 250')).toBeVisible();
    expect(container.querySelector('[data-virtualized]')).not.toBeNull();
    expect(screen.getByText('Issue number 0')).toBeInTheDocument();
    expect(screen.queryByText('Issue number 249')).toBeNull();
  });
});

describe('keyboard (§H 7)', () => {
  // cmdk measures its list; jsdom has no ResizeObserver or scrollIntoView.
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    Element.prototype.scrollIntoView ??= () => {};
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens the search with ⌘K and opens the chosen issue with Enter', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation((options: RequestOptions) =>
      Promise.resolve(
        options.path === 'np/issues' && options.query?.q === 'claim'
          ? { data: [issue('7')], nextCursor: null }
          : { data: [] },
      ),
    );
    await renderNpRoutes(
      <>
        <Route path='/inbox' element={<NpShortcuts />} />
        <Route path='/issues/:issueId' element={<p>issue page</p>} />
      </>,
      { url: '/inbox' },
    );
    await user.keyboard('{Meta>}k{/Meta}');
    const input = await screen.findByPlaceholderText(
      'Search by title or identifier…',
    );
    await user.type(input, 'claim');
    expect(await screen.findByText('Issue number 7')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/issues',
        query: expect.objectContaining({ q: 'claim', limit: 20 }),
      }),
    );
    await user.keyboard('{Enter}');
    expect(await screen.findByText('issue page')).toBeVisible();
  });

  it('creates an issue with C, but not while typing', async () => {
    const user = userEvent.setup();
    api.request.mockResolvedValue({ data: [] });
    await renderNpRoutes(
      <>
        <Route
          path='/inbox'
          element={
            <>
              <input aria-label='Notes' />
              <NpShortcuts />
            </>
          }
        />
        <Route path='/issues/new' element={<p>create dialog</p>} />
      </>,
      { url: '/inbox' },
    );
    await user.click(screen.getByRole('textbox', { name: 'Notes' }));
    await user.keyboard('c');
    expect(screen.queryByText('create dialog')).toBeNull();
    await user.click(document.body);
    await user.keyboard('c');
    expect(await screen.findByText('create dialog')).toBeVisible();
  });
});
