import { ApiClientError } from '@nocobase/app-client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PmAssistantProvider,
  usePmContextSource,
} from '../../client/pages/np/pm/assistant/pm-assistant.js';
import { PmDrawer } from '../../client/pages/np/pm/assistant/pm-drawer.js';
import PmConversationPage from '../../client/pages/np/pm/conversation-page.js';
import PmHistoryPage from '../../client/pages/np/pm/index.js';
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

async function renderConversation(url = '/pm/c1') {
  return renderNpRoutes(
    <Route
      element={
        <PmAssistantProvider available>
          <IssuePage />
          <PmConversationPage />
        </PmAssistantProvider>
      }
      path='/pm/:conversationId'
    />,
    { url },
  );
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.sessionStorage.clear();
});

afterEach(() => {
  api.request.mockReset();
  vi.unstubAllGlobals();
});

describe('conversation history (/pm)', () => {
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
    await renderNpRoutes(<Route path='/pm' element={<PmHistoryPage />} />, {
      url: '/pm',
    });
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

describe('a conversation (/pm/:id)', () => {
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
        route: '/pm/c1',
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
      context: { route: '/pm/c1', items: [] },
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

  it('collapses on the history and full-width conversation pages', async () => {
    api.request.mockImplementation(
      respond({
        'GET np/pm/conversations/c1': { data: conversation() },
        'GET np/issues/c1': { data: issueDetail({ comments: [] }) },
      }),
    );
    const user = userEvent.setup();
    await renderNpRoutes(
      <Route
        path='*'
        element={
          <PmAssistantProvider available>
            <Link to='/pm/c2'>Open another conversation</Link>
            <PmDrawer />
          </PmAssistantProvider>
        }
      />,
      { url: '/issues?pm=c1&pmMode=expanded' },
    );
    const drawer = await screen.findByTestId('np-pm-drawer');
    expect(drawer).toBeVisible();
    await user.click(
      screen.getByRole('link', { name: 'Open another conversation' }),
    );
    await waitFor(() => expect(drawer).not.toBeVisible());
    expect(drawer).not.toHaveAttribute('data-mode', 'expanded');
  });
});
