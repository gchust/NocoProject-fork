import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentDelete } from '../../client/pages/np/agents/detail/agent-delete.js';
import { npKeys } from '../../client/pages/np/constants.js';
import { renderNp, renderNpRoutes } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));
vi.mock('@/components/ui/toast', () => ({ toast }));
const agent = { id: 'a/1', name: 'Dev', provider: 'echo' } as const;
afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
});

async function confirm() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Delete agent' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('Delete Dev?');
  await user.click(
    within(dialog).getByRole('button', { name: 'Delete agent' }),
  );
}

describe('agent deletion action', () => {
  it('hides deletion from callers who do not own the agent', async () => {
    await renderNp(<AgentDelete agent={agent} canDelete={false} />);
    expect(
      screen.queryByRole('button', { name: 'Delete agent' }),
    ).not.toBeInTheDocument();
  });

  it('cancels without sending any request', async () => {
    const user = userEvent.setup();
    await renderNp(<AgentDelete agent={agent} canDelete />);
    await user.click(screen.getByRole('button', { name: 'Delete agent' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(api.request).not.toHaveBeenCalled();
  });

  it('deletes after confirmation, refreshes dependent lists and returns to the agents page', async () => {
    api.request.mockResolvedValue({ ok: true });
    const { queryClient } = await renderNpRoutes(
      <>
        <Route
          path='/agents/:id'
          element={<AgentDelete agent={agent} canDelete />}
        />
        <Route path='/agents' element={<p>Agents list</p>} />
      </>,
      { url: '/agents/a1' },
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await confirm();
    expect(api.request).toHaveBeenCalledExactlyOnceWith({
      path: 'np/agents/a%2F1',
      method: 'DELETE',
    });
    expect(await screen.findByText('Agents list')).toBeInTheDocument();
    expect(toast.add).toHaveBeenCalledWith({
      type: 'success',
      title: 'Agent Dev deleted',
    });
    for (const key of [npKeys.agents, npKeys.issues, npKeys.runtimes])
      expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
  });

  it.each([
    [403, 'FORBIDDEN', 'You do not have permission'],
    [
      409,
      'AGENT_HAS_ACTIVE_RUNS',
      'Finish or cancel all pending and active runs',
    ],
    [409, 'REVISION_CONFLICT', 'The request failed'],
    [500, 'INTERNAL_ERROR', 'The request failed'],
  ])(
    'shows localized feedback for %s / %s and allows retry',
    async (status, code, message) => {
      api.request.mockRejectedValue(
        new ApiClientError('Failure', {
          status: Number(status),
          code: String(code),
          method: 'DELETE',
          url: '/api/np/agents/a1',
        }),
      );
      await renderNp(<AgentDelete agent={agent} canDelete />);
      await confirm();
      await waitFor(() =>
        expect(toast.add).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            title: expect.stringContaining(String(message)),
          }),
        ),
      );
      expect(
        screen.getByRole('button', { name: 'Delete agent' }),
      ).toBeEnabled();
    },
  );

  it('disables deletion while the request is pending', async () => {
    let resolve!: (value: unknown) => void;
    api.request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await renderNp(<AgentDelete agent={agent} canDelete />);
    await confirm();
    expect(screen.getByRole('button', { name: 'Delete agent' })).toBeDisabled();
    resolve({ ok: true });
    await waitFor(() => expect(toast.add).toHaveBeenCalled());
    expect(api.request).toHaveBeenCalledTimes(1);
  });
});
