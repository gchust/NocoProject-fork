import './np-editor-dom.js';

import { ApiClientError } from '@nocobase/app-client';
import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import locales from '../../client/locales/index.js';
import IssueDetailPage from '../../client/pages/np/issues/detail/index.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
// One stand-in for every resolved service: the realtime client and (NP-78) the file repository manager.
const fileRepository = vi.hoisted(() => ({ uploadOne: vi.fn() }));
const realtime = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
  repository: () => fileRepository,
}));

const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);
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
    description: 'Use **SKIP LOCKED**.',
    statusKey: 'todo',
    priority: 'high',
    ownerUserId: 'u1',
    ownerName: 'Zhou',
    executorType: 'agent',
    executorId: 'a1',
    executorName: 'Claude Coder',
    activeRunCount: 0,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  },
  comments: [
    {
      id: 'c1',
      authorType: 'user',
      authorId: 'u1',
      authorName: 'Zhou',
      content: 'Ping [@Claude Coder](mention://agent/a1)',
      parentId: null,
      createdAt: NOW,
    },
    {
      id: 'c2',
      authorType: 'agent',
      authorId: 'a1',
      content: 'On it.',
      parentId: 'c1',
      createdAt: NOW,
    },
  ],
  activities: [],
  runs: [
    {
      id: 'run-1',
      agentId: 'a1',
      status: 'failed',
      triggerType: 'mention',
      failureReason: 'runtimeOffline',
      createdAt: NOW,
      startedAt: NOW,
      finishedAt: NOW,
    },
  ],
};

const AGENTS = [
  {
    id: 'a1',
    name: 'Claude Coder',
    runtimeId: 'r1',
    runtimeStatus: 'online',
    provider: 'claude',
  },
];

function respond(options: { path: string; method?: string }) {
  if (options.path === 'np/issues/101' && !options.method) {
    return Promise.resolve({ data: DETAIL });
  }
  if (options.path === 'np/agents') return Promise.resolve({ data: AGENTS });
  if (options.path === 'np/me') {
    return Promise.resolve({ data: { userId: 'u1', name: 'Zhou' } });
  }
  if (options.path === 'np/issues/101/attachments' && !options.method) {
    return Promise.resolve({ data: [] });
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
  // Narrow screen: the stacked layout avoids measuring resizable panels in jsdom.
  vi.stubGlobal('innerWidth', 500);
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  api.request.mockImplementation(respond);
});

afterEach(() => {
  api.request.mockReset();
  fileRepository.uploadOne.mockReset();
  toast.add.mockReset();
  vi.unstubAllGlobals();
});

const COLLAB_DETAIL = {
  ...DETAIL,
  parent: { id: '100', identifier: 'NP-0', title: 'Ship Phase 1' },
  subtasks: [
    {
      id: 's2',
      identifier: 'NP-3',
      title: 'Write the UI',
      statusKey: 'todo',
      stage: 2,
      executorType: 'none',
      executorName: null,
      blockedCount: 1,
    },
    {
      id: 's1',
      identifier: 'NP-2',
      title: 'Write the API',
      statusKey: 'done',
      stage: 1,
      executorType: 'agent',
      executorName: 'Claude Coder',
      blockedCount: 0,
    },
  ],
  blockedBy: [
    {
      dependencyId: 'd1',
      issueId: '90',
      identifier: 'NP-90',
      title: 'Agree on the schema',
      statusKey: 'in_review',
    },
  ],
  blocks: [],
  subscribers: [{ userId: 'u1', name: 'Zhou', reason: 'creator' }],
  labels: [{ id: 'l1', name: 'backend', color: 'blue' }],
};

describe('issue detail', () => {
  it('shows the parent, sub-issues by stage, blockers and subscription', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      (options: { path: string; method?: string }) => {
        if (options.path === 'np/issues/101' && !options.method) {
          return Promise.resolve({ data: COLLAB_DETAIL });
        }
        if (options.path === 'np/issues/101/unsubscribe') {
          return Promise.resolve({ data: { subscribed: false } });
        }
        return respond(options);
      },
    );
    await renderDetail();

    const parent = await screen.findByRole('link', { name: /NP-0/ });
    expect(parent).toHaveAttribute('href', '/issues/100');

    const subtasks = screen.getByRole('region', { name: /Sub-issues/ });
    const stages = within(subtasks).getAllByText(/^Stage \d$/u);
    expect(stages.map((node) => node.textContent)).toEqual([
      'Stage 1',
      'Stage 2',
    ]);
    expect(within(subtasks).getByText('Waiting for 1')).toBeVisible();
    expect(
      within(subtasks).getByText('New sub-issue').closest('a'),
    ).toHaveAttribute('href', '/issues/101/new-subtask');

    const dependencies = screen.getByRole('region', { name: 'Dependencies' });
    expect(within(dependencies).getByText('Agree on the schema')).toBeVisible();
    expect(
      within(dependencies).getByRole('button', {
        name: 'Remove NP-90 as a blocker',
      }),
    ).toBeVisible();

    expect(screen.getByText('backend')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Unsubscribe/ }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/101/unsubscribe',
          method: 'POST',
        }),
      ),
    );
  });

  it('renders the description, threaded comments with mention chips, and the execution log', async () => {
    await renderDetail();

    expect(
      await screen.findByRole('heading', {
        name: 'Wire up the claim endpoint',
      }),
    ).toBeVisible();
    expect(screen.getByText('SKIP LOCKED').tagName).toBe('STRONG');
    // The mention renders as a chip, not as a link to the mention:// URL.
    expect(screen.queryByRole('link', { name: '@Claude Coder' })).toBeNull();
    expect(screen.getByText('@Claude Coder')).toBeVisible();
    expect(screen.getByText('On it.')).toBeVisible();

    const log = screen.getByRole('region', { name: 'Execution log' });
    expect(within(log).getByText('Failed')).toBeVisible();
    // Failure reasons read as words, not codes (iteration 1 §J 7).
    expect(within(log).getByText('Runtime offline')).toBeVisible();
    expect(within(log).getByRole('button', { name: /Retry/ })).toBeVisible();
    expect(within(log).queryByRole('button', { name: /Stop/ })).toBeNull();
    expect(
      within(log).getByText('View transcript').closest('a'),
    ).toHaveAttribute('href', '/issues/101/runs/run-1');
  });

  it('sends the revision with a title edit and reloads on a revision conflict', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      (options: { path: string; method?: string }) =>
        options.method === 'PATCH'
          ? Promise.reject(
              new ApiClientError('conflict', {
                status: 409,
                code: 'REVISION_CONFLICT',
                method: 'PATCH',
                url: '/api/np/issues/101',
              }),
            )
          : respond(options),
    );
    await renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Edit title' }));
    const input = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.type(input, 'Renamed{Enter}');

    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/101',
          method: 'PATCH',
          json: { title: 'Renamed', revision: 3 },
        }),
      ),
    );
    const detailLoads = () =>
      api.request.mock.calls.filter(
        ([options]) =>
          (options as { path: string; method?: string }).path ===
            'np/issues/101' && !(options as { method?: string }).method,
      ).length;
    await waitFor(() => expect(detailLoads()).toBeGreaterThanOrEqual(2));
  });

  it('edits the description in the rich text editor and saves it as Markdown', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      (options: { path: string; method?: string }) =>
        options.method === 'PATCH'
          ? Promise.resolve({ data: { ...DETAIL.issue, revision: 4 } })
          : respond(options),
    );
    await renderDetail();

    await user.click(
      await screen.findByRole('button', { name: 'Edit description' }),
    );
    const editor = await screen.findByRole('textbox', { name: 'Description' });
    // The stored Markdown loads as rich text: bold stays bold.
    expect(within(editor).getByText('SKIP LOCKED').tagName).toBe('STRONG');
    // The editor opens focused with the caret at the end.
    await waitFor(() => expect(editor).toHaveFocus());
    await user.keyboard(' Then ship.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/101',
          method: 'PATCH',
          json: {
            description: 'Use **SKIP LOCKED**. Then ship.',
            revision: 3,
          },
        }),
      ),
    );
  });

  it('switches the issue to session mode and shows the conversation panel', async () => {
    const user = userEvent.setup();
    let mode = 'task';
    api.request.mockImplementation(
      (options: { path: string; method?: string; json?: unknown }) => {
        if (options.method === 'PATCH') {
          mode = (options.json as { executionMode: string }).executionMode;
          return Promise.resolve({
            data: { ...DETAIL.issue, executionMode: mode },
          });
        }
        if (options.path === 'np/issues/101' && !options.method) {
          return Promise.resolve({
            data: {
              ...DETAIL,
              issue: { ...DETAIL.issue, executionMode: mode },
            },
          });
        }
        return respond(options);
      },
    );
    await renderDetail();

    await user.click(
      await screen.findByRole('switch', { name: 'Session mode' }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          json: { executionMode: 'session', revision: 3 },
        }),
      ),
    );
    expect(await screen.findByTestId('np-session-panel')).toBeInTheDocument();
  });

  it('reports a status change that waits for approval and shows the approval card', async () => {
    const user = userEvent.setup();
    const approval = {
      id: 'ap1',
      issueId: '101',
      fromStatus: 'todo',
      toStatus: 'done',
      requestedByType: 'user',
      requestedById: 'u1',
      requestedByName: 'Zhou',
      approverUserIds: ['u9'],
      status: 'pending',
      createdAt: NOW,
    };
    let approvals: unknown[] = [];
    api.request.mockImplementation(
      (options: { path: string; method?: string }) => {
        if (options.method === 'PATCH') {
          approvals = [approval];
          return Promise.resolve({
            data: { issue: DETAIL.issue, pendingApproval: approval },
          });
        }
        if (options.path === 'np/issues/101' && !options.method) {
          return Promise.resolve({ data: { ...DETAIL, approvals } });
        }
        if (options.path === 'np/members') {
          return Promise.resolve({
            data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'owner' }],
          });
        }
        return respond(options);
      },
    );
    await renderDetail();

    await user.click(await screen.findByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Done' }));

    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          title: 'Waiting for approval',
        }),
      ),
    );
    const card = await screen.findByTestId('np-approval-card');
    expect(card).toHaveTextContent('Zhou');
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('older activity (iteration 3 §D)', () => {
  it('loads activities older than the detail on demand and merges them into the timeline', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      (options: {
        path: string;
        method?: string;
        query?: Record<string, unknown>;
      }) => {
        if (options.path === 'np/issues/101' && !options.method) {
          return Promise.resolve({
            data: { ...DETAIL, activitiesNextCursor: 'c-old' },
          });
        }
        if (options.path === 'np/issues/101/activities') {
          return Promise.resolve({
            data: [
              {
                id: 'act-old',
                actorType: 'user',
                actorId: 'u1',
                actorName: 'Ada',
                action: 'priority_changed',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
            nextCursor: null,
          });
        }
        return respond(options);
      },
    );
    await renderDetail();

    await screen.findByText('Wire up the claim endpoint');
    expect(screen.queryByText('changed the priority')).toBeNull();
    await user.click(
      screen.getByRole('button', { name: 'Load older activity' }),
    );
    expect(await screen.findByText('changed the priority')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/issues/101/activities',
        query: expect.objectContaining({ cursor: 'c-old' }),
      }),
    );
    // The last page carried no cursor, so the button goes away.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Load older activity' }),
      ).toBeNull(),
    );
  });
});

describe('attachments (NP-78)', () => {
  const ATTACHMENT = {
    id: 'f1',
    filename: 'spec.pdf',
    ext: 'pdf',
    mimeType: 'application/pdf',
    size: 2048,
    contentUrl: '/main/uploads/np/f1.pdf',
    uploadedById: 'u1',
    uploadedByName: 'Zhou',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    canDelete: true,
  };

  it('lists the attachments with download links and removes one after confirming', async () => {
    const user = userEvent.setup();
    let attachments = [
      ATTACHMENT,
      { ...ATTACHMENT, id: 'f2', filename: 'notes.txt', canDelete: false },
    ];
    api.request.mockImplementation(
      (options: { path: string; method?: string }) => {
        if (options.path === 'np/issues/101/attachments' && !options.method)
          return Promise.resolve({ data: attachments });
        if (
          options.path === 'np/issues/101/attachments/f1' &&
          options.method === 'DELETE'
        ) {
          attachments = attachments.filter((item) => item.id !== 'f1');
          return Promise.resolve(undefined);
        }
        return respond(options);
      },
    );
    await renderDetail();

    const section = await screen.findByRole('region', { name: /Attachments/ });
    expect(within(section).getByText('spec.pdf')).toBeVisible();
    expect(within(section).getAllByText(/2\.0 KB · Zhou/u)).toHaveLength(2);
    expect(
      within(section).getByRole('link', { name: 'Download: spec.pdf' }),
    ).toHaveAttribute('href', '/main/uploads/np/f1.pdf');
    // Only files the viewer may remove offer the action.
    expect(
      within(section).queryByRole('button', { name: 'Remove: notes.txt' }),
    ).toBeNull();
    await user.click(
      within(section).getByRole('button', { name: 'Remove: spec.pdf' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/101/attachments/f1',
          method: 'DELETE',
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText('spec.pdf')).toBeNull());
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: 'Attachment removed' }),
    );
  });

  it('reveals the section from the Add chip and attaches each finished upload', async () => {
    const user = userEvent.setup();
    const attached: unknown[] = [];
    fileRepository.uploadOne.mockResolvedValue({
      record: {
        ...ATTACHMENT,
        id: 'f9',
        filename: 'shot.png',
        disk: '',
        key: '',
      },
      createdTargets: [],
    });
    api.request.mockImplementation(
      (options: { path: string; method?: string; json?: unknown }) => {
        if (
          options.path === 'np/issues/101/attachments' &&
          options.method === 'POST'
        ) {
          attached.push(options.json);
          return Promise.resolve({ data: [] });
        }
        return respond(options);
      },
    );
    await renderDetail();

    expect(screen.queryByRole('region', { name: /Attachments/ })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Attachment' }));
    const section = await screen.findByRole('region', { name: /Attachments/ });
    const input = section.querySelector<HTMLInputElement>('input[type=file]');
    expect(input).not.toBeNull();
    await user.upload(
      input!,
      new File(['png'], 'shot.png', { type: 'image/png' }),
    );
    await waitFor(() => expect(attached).toEqual([{ fileIds: ['f9'] }]));
    expect(fileRepository.uploadOne).toHaveBeenCalledTimes(1);
  });
  it('uploads and attaches a file dropped onto the attachments card', async () => {
    const attached: unknown[] = [];
    fileRepository.uploadOne.mockResolvedValue({
      record: {
        ...ATTACHMENT,
        id: 'f7',
        filename: 'drop.png',
        disk: '',
        key: '',
      },
      createdTargets: [],
    });
    api.request.mockImplementation(
      (options: { path: string; method?: string; json?: unknown }) => {
        if (options.path === 'np/issues/101/attachments' && !options.method)
          return Promise.resolve({ data: [ATTACHMENT] });
        if (
          options.path === 'np/issues/101/attachments' &&
          options.method === 'POST'
        ) {
          attached.push(options.json);
          return Promise.resolve({ data: [] });
        }
        return respond(options);
      },
    );
    await renderDetail();
    const section = await screen.findByRole('region', { name: /Attachments/ });
    const dropped = new File(['png'], 'drop.png', { type: 'image/png' });
    fireEvent.drop(section, {
      dataTransfer: { files: [dropped], types: ['Files'] },
    });
    await waitFor(() => expect(attached).toEqual([{ fileIds: ['f7'] }]));
    expect(fileRepository.uploadOne).toHaveBeenCalledWith(
      { file: dropped },
      expect.anything(),
    );
  });
});

describe('activity source (NP-86)', () => {
  it('marks activities written through the CLI or an API key, and only those', async () => {
    api.request.mockImplementation(
      (options: { path: string; method?: string }) => {
        if (options.path === 'np/issues/101' && !options.method) {
          return Promise.resolve({
            data: {
              ...DETAIL,
              activities: [
                {
                  id: 'act-cli',
                  actorType: 'user',
                  actorId: 'u1',
                  actorName: 'Ada',
                  action: 'priority_changed',
                  details: { via: 'cli' },
                  createdAt: NOW,
                },
                {
                  id: 'act-key',
                  actorType: 'user',
                  actorId: 'u1',
                  actorName: 'Ada',
                  action: 'title_changed',
                  details: { via: 'api_key' },
                  createdAt: NOW,
                },
                {
                  id: 'act-browser',
                  actorType: 'user',
                  actorId: 'u1',
                  actorName: 'Ada',
                  action: 'description_changed',
                  details: null,
                  createdAt: NOW,
                },
              ],
            },
          });
        }
        return respond(options);
      },
    );
    await renderDetail();

    expect(await screen.findByText('via CLI')).toBeVisible();
    expect(screen.getByText('via API key')).toBeVisible();
    expect(screen.getAllByText(/^via /)).toHaveLength(2);
    expect(screen.getByText('edited the description')).toBeVisible();
  });
});
