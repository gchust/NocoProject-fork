import './np-editor-dom.js';

import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Issue, UpdateIssueInput } from '../../client/pages/np/types.js';
import IssueDetailPage from '../../client/pages/np/issues/detail/index.js';
import { renderNp, type RequestOptions } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const services = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
  repository: vi.fn(() => ({})),
}));
vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => services,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { add: vi.fn() } }));

afterEach(() => vi.clearAllMocks());

describe('issue properties synchronization', () => {
  it.each(['101', 'NP-1'])(
    'keeps property edits and revisions in sync at /issues/%s',
    async (routeId) => {
      const user = userEvent.setup();
      let issue: Issue = {
        id: '101',
        identifier: 'NP-1',
        number: 1,
        title: 'Sync properties',
        description: null,
        statusKey: 'todo',
        priority: 'high',
        ownerUserId: 'u1',
        ownerName: 'Zhou',
        executorType: 'none',
        executorId: null,
        projectId: 'p1',
        startDate: '2026-09-01',
        dueDate: '2026-09-30',
        revision: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      api.request.mockImplementation((options: RequestOptions) => {
        if (options.path === 'np/issues/101' && options.method === 'PATCH') {
          const changes = options.json as UpdateIssueInput & {
            revision: number;
          };
          expect(changes.revision).toBe(issue.revision);
          issue = {
            ...issue,
            ...changes,
            ...(changes.executor
              ? {
                  executorType: changes.executor.type,
                  executorId: changes.executor.id,
                }
              : {}),
            revision: issue.revision + 1,
          };
          return Promise.resolve({ data: issue });
        }
        // Opened by identifier, the page redirects to the id URL and loads it again there.
        if (
          options.path === `np/issues/${routeId}` ||
          options.path === 'np/issues/101'
        )
          return Promise.resolve({
            data: {
              issue,
              project: issue.projectId
                ? {
                    id: issue.projectId,
                    name:
                      issue.projectId === 'p1'
                        ? 'First project'
                        : 'Second project',
                  }
                : null,
            },
          });
        if (options.path === 'np/projects')
          return Promise.resolve({
            data: [
              { id: 'p1', name: 'First project' },
              { id: 'p2', name: 'Second project' },
            ],
          });
        if (options.path === 'np/me')
          return Promise.resolve({ data: { userId: 'u1', name: 'Zhou' } });
        if (options.path === 'np/members')
          return Promise.resolve({
            data: [
              { userId: 'u1', name: 'Zhou', role: 'owner' },
              { userId: 'u2', name: 'Ada', role: 'member' },
            ],
          });
        return Promise.resolve({ data: [] });
      });
      await renderNp(<IssueDetailPage />, {
        path: '/issues/:issueId',
        url: `/issues/${routeId}`,
      });
      const owner = await screen.findByRole('combobox', { name: 'Owner' });
      await user.click(owner);
      await user.click(await screen.findByRole('option', { name: 'Ada' }));
      await waitFor(() => expect(owner).toHaveTextContent('Ada'));
      const priority = screen.getByRole('combobox', { name: 'Priority' });
      await waitFor(() => expect(priority).toBeEnabled());
      await user.click(priority);
      await user.click(await screen.findByRole('option', { name: 'Low' }));
      await waitFor(() => expect(priority).toHaveTextContent('Low'));
      expect(issue.revision).toBe(5);
      for (const [name, option] of [
        ['Process', 'Design first'],
        ['Project', 'Second project'],
        ['Executor', 'Ada'],
        ['Status', 'In progress'],
      ]) {
        const control = screen.getByRole('combobox', { name });
        await waitFor(() => expect(control).toBeEnabled());
        await user.click(control);
        await user.click(
          await screen.findByRole('option', { name: option, exact: true }),
        );
        await waitFor(() => expect(control).toHaveTextContent(option));
      }
      for (const name of ['Clear start date', 'Clear due date']) {
        const clear = screen.getByRole('button', { name });
        await waitFor(() => expect(clear).toBeEnabled());
        await user.click(clear);
        await waitFor(() =>
          expect(screen.queryByRole('button', { name })).toBeNull(),
        );
      }
      const autoExecute = screen.getByRole('switch', {
        name: 'Auto-run sub-issues',
      });
      await waitFor(() => expect(autoExecute).toBeEnabled());
      await user.click(autoExecute);
      await waitFor(() => expect(autoExecute).toBeChecked());
      expect(issue.revision).toBe(12);

      // A concurrent edit must refresh the visible alias too, then use its new revision.
      const respond = api.request.getMockImplementation()!;
      let conflict = true;
      api.request.mockImplementation((options: RequestOptions) => {
        if (options.method === 'PATCH' && conflict) {
          conflict = false;
          issue = {
            ...issue,
            priority: 'urgent',
            revision: issue.revision + 1,
          };
          return Promise.reject(
            new ApiClientError('conflict', {
              status: 409,
              code: 'REVISION_CONFLICT',
              method: 'PATCH',
              url: '/api/np/issues/101',
            }),
          );
        }
        return respond(options);
      });
      await waitFor(() => expect(priority).toBeEnabled());
      await user.click(priority);
      await user.click(
        await screen.findByRole('option', { name: 'High', exact: true }),
      );
      await waitFor(() => expect(priority).toHaveTextContent('Urgent'));
      await waitFor(() => expect(priority).toBeEnabled());
      await user.click(priority);
      await user.click(
        await screen.findByRole('option', { name: 'Medium', exact: true }),
      );
      await waitFor(() => expect(priority).toHaveTextContent('Medium'));
      expect(issue.revision).toBe(14);
    },
  );
});
