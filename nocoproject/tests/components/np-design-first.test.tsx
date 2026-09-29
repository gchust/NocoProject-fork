import './np-editor-dom.js';

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DecisionContent } from '../../client/pages/np/decision/decision-content.js';
import { normalizeIssueDetail } from '../../client/pages/np/detail-normalize.js';
import { DEFAULT_STATUS_CATALOG } from '../../client/pages/np/constants.js';
import { IssueBoard } from '../../client/pages/np/issues/board/board.js';
import IssueDetailPage from '../../client/pages/np/issues/detail/index.js';
import type { InboxItem, IssueListItem } from '../../client/pages/np/types.js';
import { type RequestOptions, renderNp } from './np-harness.js';

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
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));

const NOW = new Date().toISOString();

const PROPOSAL = [
  '## 需求理解',
  '',
  'Rework the claim endpoint.',
  '',
  '## 方案',
  '',
  'Use SKIP LOCKED.',
].join('\n');

const DETAIL = {
  issue: {
    id: '101',
    identifier: 'NP-1',
    title: 'Rework the claim endpoint',
    description: null,
    statusKey: 'proposal_review',
    priority: 'high',
    ownerUserId: 'u1',
    ownerName: 'Zhou',
    executorType: 'agent',
    executorId: 'a1',
    executorName: 'Claude Coder',
    process: 'design_first',
    designApprovedAt: null,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  },
  comments: [
    {
      id: 'p1',
      authorType: 'agent',
      authorId: 'a1',
      authorName: 'Claude Coder',
      kind: 'proposal',
      content: PROPOSAL,
      parentId: null,
      sourceRunId: 'run-1',
      createdAt: NOW,
    },
    {
      id: 'retro',
      authorType: 'agent',
      authorId: 'pm',
      authorName: 'Project Manager',
      content: '/note Went well.',
      parentId: null,
      sourceRunId: 'run-retro',
      createdAt: NOW,
    },
  ],
  activities: [],
  runs: [
    {
      id: 'run-1',
      agentId: 'a1',
      status: 'completed',
      triggerType: 'assign',
      createdAt: NOW,
      finishedAt: NOW,
    },
    {
      id: 'run-retro',
      agentId: 'pm',
      status: 'completed',
      triggerType: 'retrospective',
      createdAt: NOW,
      finishedAt: NOW,
    },
  ],
};

const DECISION: InboxItem = {
  id: 'd1',
  kind: 'decision',
  type: 'design_review' as InboxItem['type'],
  issueId: '101',
  issueIdentifier: 'NP-1',
  title: 'Design proposal on NP-1',
  body: 'Claude Coder submitted a design proposal.',
  actorType: 'agent',
  actorName: 'Claude Coder',
  count: 1,
  readAt: null,
  archivedAt: null,
  resolvedAt: null,
  payload: { proposalCommentId: 'p1', summary: 'Rework the claim endpoint.' },
  createdAt: NOW,
  updatedAt: NOW,
};

function respond(posted: RequestOptions[]) {
  return (options: RequestOptions): Promise<unknown> => {
    if (options.method === 'POST') {
      posted.push(options);
      return Promise.resolve({ data: {} });
    }
    switch (options.path) {
      case 'np/issues/101':
        return Promise.resolve({ data: DETAIL });
      case 'np/inbox':
        return Promise.resolve({ data: [DECISION], nextCursor: null });
      case 'np/agents':
        return Promise.resolve({
          data: [
            {
              id: 'a1',
              name: 'Claude Coder',
              runtimeId: 'r1',
              provider: 'claude',
            },
          ],
        });
      case 'np/me':
        return Promise.resolve({ data: { userId: 'u1', name: 'Zhou' } });
      default:
        return Promise.resolve({ data: [] });
    }
  };
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 500);
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
  vi.unstubAllGlobals();
});

describe('design-first issue page (iteration 4 §B)', () => {
  it('marks the process, shows the proposal in the decision and approves it', async () => {
    const user = userEvent.setup();
    const posted: RequestOptions[] = [];
    api.request.mockImplementation(respond(posted));
    await renderNp(<IssueDetailPage />, {
      url: '/issues/101',
      path: '/issues/:issueId',
    });

    const decision = await screen.findByRole('article', {
      name: 'Design proposal to review',
    });
    expect(screen.getAllByText('Design first').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Proposal review').length).toBeGreaterThan(0);
    expect(
      within(decision).getByRole('heading', { name: '方案' }),
    ).toBeVisible();
    expect(within(decision).getByText('Use SKIP LOCKED.')).toBeVisible();

    await user.click(
      within(decision).getByRole('button', {
        name: 'Approve for development',
      }),
    );
    await waitFor(() =>
      expect(posted).toEqual([
        expect.objectContaining({ path: 'np/issues/101/design/approve' }),
      ]),
    );
  });

  it('sends the proposal back with a comment', async () => {
    const user = userEvent.setup();
    const posted: RequestOptions[] = [];
    api.request.mockImplementation(respond(posted));
    await renderNp(<IssueDetailPage />, {
      url: '/issues/101',
      path: '/issues/:issueId',
    });
    const decision = await screen.findByRole('article', {
      name: 'Design proposal to review',
    });
    await user.click(
      within(decision).getByRole('button', { name: 'Send back' }),
    );
    await user.type(
      within(decision).getByRole('textbox'),
      'Cover the migration too',
    );
    await user.click(
      within(decision).getAllByRole('button', { name: 'Send back' }).at(-1)!,
    );
    await waitFor(() =>
      expect(posted).toEqual([
        expect.objectContaining({
          path: 'np/issues/101/design/request-changes',
          json: { comment: 'Cover the migration too' },
        }),
      ]),
    );
  });

  it('tags the proposal and the retrospective note in the timeline', async () => {
    api.request.mockImplementation(respond([]));
    await renderNp(<IssueDetailPage />, {
      url: '/issues/101',
      path: '/issues/:issueId',
    });
    const activity = await screen.findByRole('list', { name: 'Activity' });
    await waitFor(() =>
      expect(
        activity.querySelector('[data-comment-tag="proposal"]'),
      ).not.toBeNull(),
    );
    expect(within(activity).getByText('Proposal')).toBeVisible();
    expect(within(activity).getByText('Retrospective')).toBeVisible();
  });
});

describe('design review in the inbox (iteration 4 §B)', () => {
  it('shows the proposal the decision names, or the summary until the issue loads', async () => {
    const detail = normalizeIssueDetail(DETAIL as never);
    const first = await renderNp(
      <DecisionContent
        item={DECISION}
        detail={detail}
        agents={[]}
        detailLoading={false}
      />,
    );
    expect(screen.getByText('Use SKIP LOCKED.')).toBeVisible();
    expect(screen.getByText('Proposal')).toBeVisible();
    first.unmount();

    await renderNp(
      <DecisionContent
        item={DECISION}
        detail={undefined}
        agents={[]}
        detailLoading={false}
      />,
    );
    expect(screen.getByText('Proposal summary')).toBeVisible();
    expect(screen.getByText('Rework the claim endpoint.')).toBeVisible();
  });
});

describe('design-first board (iteration 4 §B)', () => {
  const issue = (overrides: Partial<IssueListItem>): IssueListItem => ({
    id: '1',
    identifier: 'NP-1',
    title: 'Plain work',
    statusKey: 'todo',
    priority: 'none',
    ownerUserId: 'u1',
    executorType: 'none',
    executorId: null,
    updatedAt: NOW,
    revision: 1,
    ...overrides,
  });

  it('hides the design columns until an issue uses the process, and badges its card', async () => {
    const first = await renderNp(
      <IssueBoard
        groups={[{ statusKey: 'todo', issues: [issue({})] }]}
        catalog={DEFAULT_STATUS_CATALOG}
      />,
    );
    const board = screen.getByRole('region', { name: 'Issue board' });
    expect(
      within(board).queryByRole('region', { name: /Analysis/ }),
    ).toBeNull();
    expect(within(board).queryByText('Design first')).toBeNull();
    first.unmount();

    await renderNp(
      <IssueBoard
        groups={[
          {
            statusKey: 'todo',
            issues: [
              issue({ id: '2', title: 'Big rework', process: 'design_first' }),
            ],
          },
        ]}
        catalog={DEFAULT_STATUS_CATALOG}
      />,
    );
    const next = screen.getByRole('region', { name: 'Issue board' });
    expect(
      within(next).getByRole('region', { name: /Analysis/ }),
    ).toBeVisible();
    expect(
      within(next).getByRole('region', { name: /Proposal review/ }),
    ).toBeVisible();
    const todo = within(next).getByRole('region', { name: /Todo/ });
    expect(within(todo).getByText('Design first')).toBeVisible();
  });
});
