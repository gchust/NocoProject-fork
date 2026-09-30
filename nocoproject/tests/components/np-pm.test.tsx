import { ApiClientError } from '@nocobase/app-client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ReactNode } from 'react';
import { Outlet, Route, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PmAssistantProvider,
  usePmContextSource,
} from '../../client/pages/np/pm/assistant/pm-assistant.js';
import { PmDrawer } from '../../client/pages/np/pm/assistant/pm-drawer.js';
import { PmHeaderButton } from '../../client/pages/np/pm/assistant/pm-launchers.js';
import PmRoute from '../../client/pages/np/pm/pm-route.js';
import type { PmPlan } from '../../client/pages/np/types-pm.js';
import { type RequestOptions, renderNpRoutes } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const services = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
  repository: vi.fn(() => ({})),
}));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => services,
}));
vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);

const NOW = new Date().toISOString();
const LATER = new Date(Date.now() + 5 * 3_600_000).toISOString();

const AGENT = {
  id: 'pm',
  name: 'Project Manager',
  source: 'system',
  online: true,
  runtimeName: 'server',
  compat: 'ok',
  personalAvailable: false,
} as const;

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    issueId: 'c1',
    identifier: null,
    title: 'Plan the release',
    titleSource: 'agent',
    lastMessageAt: NOW,
    archivedAt: null,
    agent: AGENT,
    running: false,
    pendingPlanCount: 1,
    ...overrides,
  };
}

function issueDetail(options: { runs?: unknown[]; comments?: unknown[] } = {}) {
  return {
    issue: {
      id: 'c1',
      identifier: null,
      title: 'Plan the release',
      description: null,
      statusKey: 'todo',
      priority: 'none',
      ownerUserId: 'u1',
      executorType: 'agent',
      executorId: 'pm',
      executionMode: 'session',
      originType: 'pm',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    comments: options.comments ?? [
      {
        id: 'm1',
        authorType: 'user',
        authorId: 'u1',
        authorName: 'Zhou',
        content: 'What is left for the release?',
        parentId: null,
        createdAt: NOW,
        context: {
          route: '/issues/i9',
          items: [
            { type: 'issue', id: 'i9', identifier: 'NP-9', title: 'Ship it' },
          ],
        },
      },
      {
        id: 'm2',
        authorType: 'agent',
        authorId: 'pm',
        authorName: 'Project Manager',
        content: 'Here is a plan.',
        parentId: null,
        createdAt: NOW,
      },
      {
        id: 'm3',
        authorType: 'agent',
        authorId: 'pm',
        content: 'Plan',
        kind: 'plan',
        parentId: null,
        createdAt: NOW,
      },
    ],
    activities: [],
    runs: options.runs ?? [],
  };
}

function plan(overrides: Partial<PmPlan> = {}): PmPlan {
  return {
    id: 'p1',
    conversationId: 'c1',
    status: 'pending',
    title: 'Release tasks',
    summary: null,
    revision: 3,
    expiresAt: LATER,
    executable: true,
    result: null,
    createdAt: NOW,
    executedAt: null,
    commentId: 'm3',
    rows: [
      {
        seq: 1,
        ref: 't1',
        type: 'issue.create',
        params: { title: 'Write notes', priority: 'high' },
        status: 'pending',
        ok: true,
        preview: [],
        flags: [],
        warnings: [],
      },
      {
        seq: 2,
        ref: null,
        type: 'issue.create',
        params: { title: 'Publish', parent: { ref: 't1' } },
        status: 'pending',
        ok: true,
        preview: [],
        flags: [],
        warnings: [],
      },
      {
        seq: 3,
        ref: null,
        type: 'issue.status',
        params: { issue: 'NP-9', statusKey: 'cancelled' },
        status: 'pending',
        ok: true,
        preview: [],
        flags: ['terminal'],
        warnings: [],
        baseline: { statusKey: 'todo' },
      },
    ],
    ...overrides,
  };
}

type Handler = (options: RequestOptions) => unknown;

function respond(routes: Record<string, unknown | Handler>) {
  return (options: RequestOptions): Promise<unknown> => {
    const key = `${options.method ?? 'GET'} ${options.path}`;
    if (key in routes) {
      const value = routes[key];
      try {
        return Promise.resolve(
          typeof value === 'function' ? (value as Handler)(options) : value,
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return (options.method ?? 'GET') === 'GET'
      ? Promise.resolve({ data: [] })
      : Promise.reject(new Error(`unexpected ${key}`));
  };
}

function calls(method: string, path: string): RequestOptions[] {
  return api.request.mock.calls
    .map(([options]) => options as RequestOptions)
    .filter(
      (options) =>
        (options.method ?? 'GET') === method && options.path === path,
    );
}

function conflict(code: string, status = 409): ApiClientError {
  return new ApiClientError(code, {
    status,
    code,
    method: 'POST',
    url: '/api/np',
  });
}

/** A page registering an issue as context, beside the drawer, the way the issue detail does. */
function IssuePage(): null {
  usePmContextSource({ type: 'issue', id: 'i9', label: 'NP-9 Ship it' });
  return null;
}

/** The shell as far as the project manager goes: a page, the top bar's button, the drawer and the `/pm` routes. */
function Shell() {
  return (
    <PmAssistantProvider available>
      <Outlet />
      <PmHeaderButton />
      <PmDrawer />
    </PmAssistantProvider>
  );
}

function shellRoutes(page: ReactNode = <IssuePage />) {
  return (
    <Route element={<Shell />}>
      <Route path='/pm' element={<PmRoute />} />
      <Route path='/pm/:conversationId' element={<PmRoute />} />
      <Route path='*' element={page} />
    </Route>
  );
}

async function renderConversation(url = '/issues/i9?pm=c1') {
  return renderNpRoutes(shellRoutes(), { url });
}

/** `matchMedia` answering `matches` for every query: true stands for a screen where the drawer docks. */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  stubMatchMedia(false);
  window.sessionStorage.clear();
});

afterEach(() => {
  api.request.mockReset();
  vi.unstubAllGlobals();
});

describe('conversation history (drawer)', () => {
  it('lists conversations, searches them and archives one', async () => {
    api.request.mockImplementation(
      respond({
        'GET np/pm/conversations': { data: [conversation()], nextCursor: null },
        'PATCH np/pm/conversations/c1': (options: RequestOptions) => ({
          data: conversation({ archivedAt: NOW, ...(options.json as object) }),
        }),
      }),
    );
    const user = userEvent.setup();
    await renderNpRoutes(shellRoutes(), { url: '/issues?pm=history' });
    expect(await screen.findByText('Plan the release')).toBeVisible();
    expect(screen.getByText('1 plans waiting')).toBeVisible();

    await user.type(
      screen.getByRole('searchbox', { name: 'Search conversations' }),
      'release',
    );
    await waitFor(() =>
      expect(
        calls('GET', 'np/pm/conversations').some(
          (options) => options.query?.q === 'release',
        ),
      ).toBe(true),
    );

    await user.click(
      screen.getByRole('button', { name: 'Actions for Plan the release' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() =>
      expect(calls('PATCH', 'np/pm/conversations/c1')[0]?.json).toEqual({
        archived: true,
      }),
    );
  });
});

describe('a conversation', () => {
  function routes(extra: Record<string, unknown | Handler> = {}) {
    return respond({
      'GET np/pm/conversations/c1': { data: conversation() },
      'GET np/issues/c1': { data: issueDetail() },
      'GET np/pm/conversations/c1/plans': { data: [plan()] },
      ...extra,
    });
  }

  it('shows messages, the context a message carried and the plan card', async () => {
    api.request.mockImplementation(routes());
    await renderConversation();
    expect(
      await screen.findByText('What is left for the release?'),
    ).toBeVisible();
    const sent = screen.getByRole('list', {
      name: 'Context sent with this message',
    });
    expect(within(sent).getByText('NP-9 Ship it')).toBeVisible();
    expect(await screen.findByText('Release tasks')).toBeVisible();
    expect(screen.getByRole('log', { name: 'Messages' })).toBeVisible();
  });

  it('sends the page context with the message, without removed tags', async () => {
    api.request.mockImplementation(
      routes({
        'POST np/issues/c1/comments': {
          data: {
            comment: {
              id: 'm9',
              authorType: 'user',
              authorId: 'u1',
              content: 'Close NP-9',
              parentId: null,
              createdAt: NOW,
            },
            triggered: [],
          },
        },
      }),
    );
    const user = userEvent.setup();
    await renderConversation();
    const chips = await screen.findByTestId('np-pm-context-chips');
    expect(within(chips).getByText('NP-9 Ship it')).toBeVisible();

    const box = screen.getByRole('textbox', {
      name: 'Message to the project manager',
    });
    await user.type(box, 'Close NP-9{Enter}');
    await waitFor(() =>
      expect(calls('POST', 'np/issues/c1/comments')).toHaveLength(1),
    );
    expect(calls('POST', 'np/issues/c1/comments')[0].json).toEqual({
      content: 'Close NP-9',
      context: {
        route: '/issues/i9',
        items: [{ type: 'issue', id: 'i9' }],
      },
    });

    await user.click(
      screen.getByRole('button', { name: 'Remove context: NP-9 Ship it' }),
    );
    expect(screen.queryByTestId('np-pm-context-chips')).toBeNull();
    await user.type(box, 'And the rest{Enter}');
    await waitFor(() =>
      expect(calls('POST', 'np/issues/c1/comments')).toHaveLength(2),
    );
    expect(calls('POST', 'np/issues/c1/comments')[1].json).toEqual({
      content: 'And the rest',
      context: { route: '/issues/i9', items: [] },
    });
  });

  it('keeps the message and says so when no project manager can answer', async () => {
    api.request.mockImplementation(
      routes({
        'POST np/issues/c1/comments': {
          data: {
            comment: {
              id: 'm9',
              authorType: 'user',
              authorId: 'u1',
              content: 'Anyone?',
              parentId: null,
              createdAt: NOW,
            },
            triggered: [],
            conversation: { agent: null },
          },
        },
      }),
    );
    const user = userEvent.setup();
    await renderConversation();
    await user.type(
      await screen.findByRole('textbox', {
        name: 'Message to the project manager',
      }),
      'Anyone?{Enter}',
    );
    expect(await screen.findByTestId('np-pm-not-configured')).toBeVisible();
    expect(
      screen.getByText(
        'Your message is saved and will be answered once a project manager is available.',
      ),
    ).toBeVisible();
  });

  it('stops the turn in progress', async () => {
    api.request.mockImplementation(
      routes({
        'GET np/issues/c1': {
          data: issueDetail({
            runs: [
              {
                id: 'r1',
                agentId: 'pm',
                status: 'running',
                createdAt: NOW,
                startedAt: NOW,
              },
            ],
          }),
        },
        'GET np/runs/r1/events': { data: [], last: null },
        'POST np/runs/r1/cancel': { data: {} },
      }),
    );
    const user = userEvent.setup();
    await renderConversation();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(calls('POST', 'np/runs/r1/cancel')).toHaveLength(1),
    );
  });

  it('offers the default while the personal agent is offline', async () => {
    const offline = conversation({
      agent: { ...AGENT, source: 'personal', online: false },
    });
    api.request.mockImplementation(
      routes({
        'GET np/pm/conversations/c1': { data: offline },
        'POST np/pm/conversations/c1/fallback': {
          data: conversation({
            agent: { ...AGENT, source: 'fallback', personalAvailable: true },
          }),
        },
      }),
    );
    const user = userEvent.setup();
    await renderConversation();
    expect(
      await screen.findByText(
        'The computer your project manager runs on is offline',
      ),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', {
        name: 'Use the default for this conversation',
      }),
    );
    await waitFor(() =>
      expect(calls('POST', 'np/pm/conversations/c1/fallback')).toHaveLength(1),
    );
    expect(
      await screen.findByRole('button', {
        name: 'Return to my project manager',
      }),
    ).toBeVisible();
  });

  it('says the default is waiting on an upgrade, with nothing to switch to', async () => {
    api.request.mockImplementation(
      routes({
        'GET np/pm/conversations/c1': {
          data: conversation({
            agent: { ...AGENT, compat: 'upgrade_required' },
          }),
        },
      }),
    );
    await renderConversation();
    expect(
      await screen.findByText(
        'The computer the default project manager runs on needs a CLI upgrade',
      ),
    ).toBeVisible();
    expect(screen.getAllByText('Needs upgrade')[0]).toBeVisible();
    expect(
      screen.queryByRole('button', {
        name: 'Use the default for this conversation',
      }),
    ).toBeNull();
  });
});

describe('plan card', () => {
  function routes(extra: Record<string, unknown | Handler> = {}) {
    return respond({
      'GET np/pm/conversations/c1': { data: conversation() },
      'GET np/issues/c1': { data: issueDetail() },
      'GET np/pm/conversations/c1/plans': { data: [plan()] },
      ...extra,
    });
  }

  it('shows the tree, keeps referenced rows and confirms a closing row before executing', async () => {
    const executed = plan({
      status: 'executed',
      executable: false,
      rows: plan().rows.map((row) => ({
        ...row,
        status: 'done' as const,
        resultType: 'issue',
        resultId: `i${row.seq}`,
        warnings: row.seq === 2 ? ['runNotStarted'] : [],
      })),
    });
    let current = plan();
    api.request.mockImplementation(
      routes({
        'GET np/pm/conversations/c1/plans': () => ({ data: [current] }),
        'POST np/pm/plans/p1/execute': () => {
          current = executed;
          return { data: executed };
        },
      }),
    );
    const user = userEvent.setup();
    await renderConversation();
    const card = await screen.findByTestId('np-pm-plan');
    // The parent of "Publish" cannot be removed; the child can.
    expect(
      within(card).getByRole('button', { name: 'Remove Write notes' }),
    ).toBeDisabled();
    expect(
      within(card).getByRole('button', { name: 'Remove Publish' }),
    ).toBeEnabled();
    expect(within(card).getByText('Closes an issue')).toBeVisible();

    await user.click(within(card).getByRole('button', { name: 'Execute' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Closes an issue/u)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Execute' }));
    await waitFor(() =>
      expect(calls('POST', 'np/pm/plans/p1/execute')[0]?.json).toEqual({
        revision: 3,
      }),
    );
    expect(await screen.findByText('Executed, run not started')).toBeVisible();
  });

  it('saves an edited row with the revision and executes only after saving', async () => {
    api.request.mockImplementation(
      routes({
        'PATCH np/pm/plans/p1': { data: plan({ revision: 4 }) },
      }),
    );
    const user = userEvent.setup();
    await renderConversation();
    const card = await screen.findByTestId('np-pm-plan');
    await user.click(
      within(card).getByRole('button', { name: 'Edit Publish' }),
    );
    const title = within(card).getAllByLabelText('Title')[0];
    await user.clear(title);
    await user.type(title, 'Publish notes');
    expect(within(card).queryByRole('button', { name: 'Execute' })).toBeNull();
    await user.click(
      within(card).getByRole('button', { name: 'Save changes' }),
    );
    await waitFor(() =>
      expect(calls('PATCH', 'np/pm/plans/p1')[0]?.json).toEqual({
        revision: 3,
        ops: [
          {
            seq: 2,
            params: { title: 'Publish notes', parent: { ref: 't1' } },
          },
        ],
      }),
    );
  });

  it('reloads the plan on a revision conflict', async () => {
    api.request.mockImplementation(
      routes({
        'PATCH np/pm/plans/p1': () => {
          throw conflict('REVISION_CONFLICT');
        },
      }),
    );
    const user = userEvent.setup();
    await renderConversation();
    const card = await screen.findByTestId('np-pm-plan');
    await user.click(
      within(card).getByRole('button', { name: 'Remove Publish' }),
    );
    await user.click(
      within(card).getByRole('button', { name: 'Save changes' }),
    );
    await waitFor(() =>
      expect(
        calls('GET', 'np/pm/conversations/c1/plans').length,
      ).toBeGreaterThan(1),
    );
  });

  it('folds a discarded plan into one line', async () => {
    api.request.mockImplementation(
      routes({
        'GET np/pm/conversations/c1/plans': {
          data: [plan({ status: 'discarded' })],
        },
      }),
    );
    await renderConversation();
    const card = await screen.findByTestId('np-pm-plan');
    expect(within(card).getByText('Discarded')).toBeVisible();
    expect(within(card).queryByText('Write notes')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Execute' })).toBeNull();
  });
});

describe('drawer', () => {
  it('opens with ⌘J, stays across pages and closes with Escape', async () => {
    api.request.mockImplementation(respond({}));
    const { queryClient } = await renderNpRoutes(
      <Route
        path='*'
        element={
          <PmAssistantProvider available>
            <IssuePage />
            <PmDrawer />
          </PmAssistantProvider>
        }
      />,
      { url: '/issues/i9' },
    );
    expect(queryClient).toBeDefined();
    expect(screen.queryByTestId('np-pm-drawer')).toBeNull();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    const drawer = await screen.findByTestId('np-pm-drawer');
    expect(drawer).toBeVisible();
    expect(drawer).not.toHaveAttribute('role', 'dialog');
    expect(
      within(drawer).getByText('What should I take care of?'),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        within(drawer).getByRole('textbox', {
          name: 'Message to the project manager',
        }),
      ).toHaveFocus(),
    );
    expect(within(drawer).getByText('NP-9 Ship it')).toBeVisible();

    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(drawer).not.toBeVisible());
    // Closed, it stays mounted (subscriptions and a streaming turn carry on).
    expect(screen.getByTestId('np-pm-drawer')).toBeInTheDocument();
  });

  it('opens from ?pm= on a conversation, expanded', async () => {
    api.request.mockImplementation(
      respond({
        'GET np/pm/conversations/c1': { data: conversation() },
        'GET np/issues/c1': { data: issueDetail({ comments: [] }) },
      }),
    );
    await renderNpRoutes(
      <Route
        path='*'
        element={
          <PmAssistantProvider available>
            <PmDrawer />
          </PmAssistantProvider>
        }
      />,
      { url: '/issues?pm=c1&pmMode=expanded' },
    );
    const drawer = await screen.findByTestId('np-pm-drawer');
    expect(drawer).toHaveAttribute('data-mode', 'expanded');
    expect(await within(drawer).findByText('Plan the release')).toBeVisible();
  });

  it('opens the history from its header button and returns to a conversation', async () => {
    api.request.mockImplementation(
      respond({
        'GET np/pm/conversations': { data: [conversation()], nextCursor: null },
        'GET np/pm/conversations/c1': { data: conversation() },
        'GET np/issues/c1': { data: issueDetail({ comments: [] }) },
      }),
    );
    const user = userEvent.setup();
    await renderNpRoutes(shellRoutes(), { url: '/issues/i9' });
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    const drawer = await screen.findByTestId('np-pm-drawer');
    const history = within(drawer).getByRole('button', {
      name: 'Conversation history',
    });
    expect(history).toHaveAttribute('aria-pressed', 'false');
    await user.click(history);
    expect(within(drawer).getByTestId('np-pm-history')).toBeVisible();
    expect(history).toHaveAttribute('aria-pressed', 'true');
    await user.click(await within(drawer).findByText('Plan the release'));
    expect(within(drawer).queryByTestId('np-pm-history')).toBeNull();
    expect(
      await within(drawer).findByRole('button', {
        name: /Plan the release/,
      }),
    ).toBeVisible();
  });

  it('opens /pm/:id in the drawer and leaves the route', async () => {
    api.request.mockImplementation(
      respond({
        'GET np/pm/conversations/c1': { data: conversation() },
        'GET np/issues/c1': { data: issueDetail({ comments: [] }) },
      }),
    );
    function Where() {
      return <p data-testid='where'>{useLocation().pathname}</p>;
    }
    await renderNpRoutes(shellRoutes(<Where />), { url: '/pm/c1' });
    const drawer = await screen.findByTestId('np-pm-drawer');
    expect(drawer).toBeVisible();
    expect(await within(drawer).findByText('Plan the release')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/'),
    );
  });

  it('opens /pm on the history', async () => {
    api.request.mockImplementation(
      respond({
        'GET np/pm/conversations': { data: [conversation()], nextCursor: null },
      }),
    );
    await renderNpRoutes(shellRoutes(), { url: '/pm' });
    const drawer = await screen.findByTestId('np-pm-drawer');
    expect(within(drawer).getByTestId('np-pm-history')).toBeVisible();
  });
});

describe('first visit', () => {
  const routes = {
    'GET np/pm/conversations': {
      data: [conversation(), conversation({ id: 'c0', title: 'Older' })],
      nextCursor: null,
    },
    'GET np/pm/conversations/c1': { data: conversation() },
    'GET np/issues/c1': { data: issueDetail({ comments: [] }) },
  };

  it('opens the drawer docked on the latest conversation, without taking the focus', async () => {
    stubMatchMedia(true);
    api.request.mockImplementation(respond(routes));
    await renderNpRoutes(shellRoutes(), { url: '/issues/i9' });
    const drawer = await screen.findByTestId('np-pm-drawer');
    expect(drawer).toBeVisible();
    expect(drawer).toHaveAttribute('data-mode', 'docked');
    expect(await within(drawer).findByText('Plan the release')).toBeVisible();
    expect(
      calls('GET', 'np/pm/conversations')[0]?.query?.archived,
    ).toBeUndefined();
    expect(drawer).not.toContainElement(
      document.activeElement as HTMLElement | null,
    );
  });

  it('shows a new conversation when there is none', async () => {
    stubMatchMedia(true);
    api.request.mockImplementation(respond({}));
    await renderNpRoutes(shellRoutes(), { url: '/issues/i9' });
    const drawer = await screen.findByTestId('np-pm-drawer');
    expect(within(drawer).getByText('New conversation')).toBeVisible();
  });

  it('stays closed after the member closed it, until a new session', async () => {
    stubMatchMedia(true);
    api.request.mockImplementation(respond(routes));
    const user = userEvent.setup();
    const first = await renderNpRoutes(shellRoutes(), { url: '/issues/i9' });
    const drawer = await screen.findByTestId('np-pm-drawer');
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(drawer).not.toBeVisible());
    first.unmount();

    // A reload in the same session.
    await renderNpRoutes(shellRoutes(), { url: '/issues/i9' });
    expect(screen.queryByTestId('np-pm-drawer')).toBeNull();
    expect(screen.getByTestId('np-pm-header-button')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('stays closed where the drawer would cover the page', async () => {
    stubMatchMedia(false);
    api.request.mockImplementation(respond(routes));
    await renderNpRoutes(shellRoutes(), { url: '/issues/i9' });
    expect(screen.getByTestId('np-pm-header-button')).toBeVisible();
    expect(screen.queryByTestId('np-pm-drawer')).toBeNull();
    expect(calls('GET', 'np/pm/conversations')).toHaveLength(0);
  });
});

describe('launcher', () => {
  it('breathes in the brand gradient, brighter while a reply runs and still once the drawer is open', async () => {
    api.request.mockImplementation(
      respond({
        'GET np/pm/conversations/c1': { data: conversation({ running: true }) },
        'GET np/issues/c1': { data: issueDetail({ comments: [] }) },
      }),
    );
    await renderNpRoutes(shellRoutes(), { url: '/issues/i9?pm=c1' });
    const button = screen.getByTestId('np-pm-header-button');
    expect(button).toHaveClass('np-pm-launcher');
    await waitFor(() => expect(button).toHaveAttribute('data-attention'));
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('animates only transform and opacity, and not at all under reduced motion', () => {
    const css = readFileSync(
      path.join(process.cwd(), 'client/styles.css'),
      'utf8',
    );
    const keyframes = [
      ...css.matchAll(/@keyframes np-pm-[a-z]+ \{([\s\S]*?)\n\}/gu),
    ];
    expect(keyframes).toHaveLength(2);
    for (const [, body] of keyframes) {
      const properties = [...body!.matchAll(/([a-z-]+):/gu)].map((m) => m[1]);
      expect(new Set(properties)).toEqual(
        new Set(properties.filter((p) => p === 'transform' || p === 'opacity')),
      );
    }
    const launcher = css.slice(css.indexOf('.np-pm-launcher {'));
    const reduced = launcher.slice(
      launcher.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    expect(reduced).toMatch(/^@media[^{]+\{\s+animation: none;/u);
    expect(reduced).toMatch(/&::before \{\s+animation: none;/u);
  });
});
