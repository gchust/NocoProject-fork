import './np-editor-dom.js';

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import IssueDetailPage from '../../client/pages/np/issues/detail/index.js';
import { answer, renderNpRoutes, type RequestOptions } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const realtime = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { add: vi.fn() } }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));

const NOW = new Date().toISOString();

const ISSUE = {
  id: '101',
  number: 1,
  identifier: 'NP-1',
  title: 'Blocked without a project',
  description: '',
  statusKey: 'blocked',
  priority: 'high',
  ownerUserId: 'u1',
  ownerName: 'Zhou',
  executorType: 'none',
  executorId: null,
  projectId: null,
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

const PROJECT = { id: 'p1', name: 'Alpha', leadUserId: 'u1' };

/** A server that keeps one issue: GET by id or identifier, PATCH checks and bumps the revision. */
function server() {
  let issue: Record<string, unknown> = { ...ISSUE };
  const detail = () => ({
    data: {
      issue,
      comments: [],
      activities: [],
      runs: [],
      project: issue.projectId ? { id: PROJECT.id, name: PROJECT.name } : null,
    },
  });
  const patches: unknown[] = [];
  const request = answer({
    'GET np/issues/101': detail,
    'GET np/issues/NP-1': detail,
    'PATCH np/issues/101': (options: RequestOptions) => {
      const { revision, ...changes } = options.json as { revision: number };
      patches.push(options.json);
      if (revision !== issue.revision)
        throw new Error(`stale revision ${revision}`);
      issue = { ...issue, ...changes, revision: revision + 1 };
      return { data: issue };
    },
    'GET np/issues/101/attachments': { data: [] },
    'GET np/agents': { data: [] },
    'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
    'GET np/members': {
      data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'owner' }],
    },
    'GET np/projects': { data: [PROJECT] },
    'GET np/labels': { data: [] },
  });
  return { request, patches };
}

function CurrentPath() {
  const location = useLocation();
  return <output data-testid='path'>{location.pathname}</output>;
}

function routes(child?: string) {
  return (
    <Route
      path='/issues/:issueId'
      element={
        <>
          <IssueDetailPage />
          <CurrentPath />
        </>
      }
    >
      {child ? <Route path={child} element={null} /> : null}
    </Route>
  );
}

afterEach(() => api.request.mockReset());

describe('issue opened by identifier (NP-127)', () => {
  it('moves to the id URL, then saves a project picked in the panel and keeps editing', async () => {
    const user = userEvent.setup();
    const { request, patches } = server();
    api.request.mockImplementation(request);
    await renderNpRoutes(routes(), { url: '/issues/NP-1' });

    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/issues/101'),
    );
    const project = await screen.findByRole('combobox', { name: 'Project' });
    await waitFor(() => expect(project).not.toHaveAttribute('data-disabled'));
    await user.click(project);
    await user.click(await screen.findByRole('option', { name: 'Alpha' }));

    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Project' }),
      ).toHaveTextContent('Alpha'),
    );
    // The next edit carries the revision the project change produced.
    await user.click(screen.getByRole('combobox', { name: 'Priority' }));
    await user.click(await screen.findByRole('option', { name: 'Low' }));
    await waitFor(() =>
      expect(patches).toEqual([
        { projectId: 'p1', revision: 3 },
        { priority: 'low', revision: 4 },
      ]),
    );
  });

  it('keeps a child route when replacing the identifier', async () => {
    const { request } = server();
    api.request.mockImplementation(request);
    await renderNpRoutes(routes('new-subtask'), {
      url: '/issues/NP-1/new-subtask',
    });

    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent(
        '/issues/101/new-subtask',
      ),
    );
  });
});
