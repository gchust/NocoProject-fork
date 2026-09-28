import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NOW,
  item,
  pane,
  renderInbox,
  withDecisions,
} from './np-inbox-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const realtime = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  onOpen: vi.fn(() => () => {}),
}));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));
vi.mock('@/components/ui/toast', () => ({ toast }));

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
  realtime.subscribe.mockClear();
});

describe('inbox decisions', () => {
  it('acts on a decision from payload.actions and resolves the card at once', async () => {
    const user = userEvent.setup();
    const review = item({
      payload: {
        actions: [
          {
            key: 'accept',
            label: 'np.inboxActions.accept',
            kind: 'primary',
            method: 'POST',
            path: '/np/issues/101/deliveries/accept',
          },
          {
            key: 'requestChanges',
            label: 'np.inboxActions.requestChanges',
            kind: 'secondary',
            method: 'POST',
            path: '/np/issues/101/deliveries/request-changes',
            needsComment: true,
          },
          {
            key: 'open',
            label: 'np.inboxActions.open',
            kind: 'secondary',
            opensIssue: true,
          },
        ],
      },
    });
    let accept: (value: unknown) => void = () => {};
    api.request.mockImplementation(
      (options: { path: string; method?: string; json?: unknown }) => {
        if (options.path === 'np/issues/101/deliveries/accept') {
          return new Promise((resolve) => {
            accept = resolve;
          });
        }
        return withDecisions([review])(options as never);
      },
    );
    await renderInbox();

    const decisions = await screen.findByRole('list', {
      name: 'Needs my decision',
    });
    const card = within(decisions).getByRole('listitem');
    // The primary action comes first and is the filled one; navigation comes last.
    const buttons = within(pane())
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('data-action'))
      .map((button) => button.getAttribute('data-action'));
    expect(buttons).toEqual(['accept', 'requestChanges', 'open']);
    await user.click(within(pane()).getByRole('button', { name: 'Accept' }));
    // Optimistic: the card shows resolved before the server answers.
    expect(await within(card).findByText('Resolved')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/issues/101/deliveries/accept',
        method: 'POST',
        json: {},
      }),
    );
    accept({ data: {} });
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success' }),
      ),
    );
  });

  it('asks for a comment before an action that needs one and sends it', async () => {
    const user = userEvent.setup();
    const review = item({
      payload: {
        actions: [
          {
            key: 'requestChanges',
            label: 'np.inboxActions.requestChanges',
            kind: 'secondary',
            method: 'POST',
            path: '/np/issues/101/deliveries/request-changes',
            needsComment: true,
          },
        ],
      },
    });
    api.request.mockImplementation(withDecisions([review]));
    await renderInbox();
    await screen.findByRole('list', { name: 'Needs my decision' });

    await user.click(
      within(pane()).getByRole('button', { name: 'Request changes' }),
    );
    const box = screen.getByRole('textbox', {
      name: 'Request changes: NP-1 is ready for review',
    });
    const send = within(pane()).getByRole('button', {
      name: 'Request changes',
    });
    expect(send).toBeDisabled();
    await user.type(box, 'Please add tests');
    await user.click(send);
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/101/deliveries/request-changes',
          method: 'POST',
          json: { comment: 'Please add tests' },
        }),
      ),
    );
  });

  it('falls back to type defaults: a blocked agent gets a reply sent as a comment', async () => {
    const user = userEvent.setup();
    const blocked = item({
      id: 'n7',
      type: 'agent_blocked',
      title: 'Claude Coder is blocked on NP-1',
      payload: null,
    });
    api.request.mockImplementation(withDecisions([blocked]));
    await renderInbox();
    await screen.findByRole('list', { name: 'Needs my decision' });

    expect(
      within(pane()).getByRole('button', { name: 'Reassign' }),
    ).toBeVisible();
    await user.click(within(pane()).getByRole('button', { name: 'Reply' }));
    await user.type(
      screen.getByRole('textbox', {
        name: 'Reply: Claude Coder is blocked on NP-1',
      }),
      'Use the staging key{Meta>}{Enter}{/Meta}',
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/101/comments',
          method: 'POST',
          json: { content: 'Use the staging key' },
        }),
      ),
    );
  });

  it('opens an external PR in a new tab and an issue action in the app', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const pr = item({
      id: 'n8',
      type: 'pr_review',
      title: 'NP-1 PR ready',
      readAt: NOW,
      payload: { url: 'https://github.com/acme/app/pull/7' },
    });
    api.request.mockImplementation(withDecisions([pr]));
    await renderInbox();
    await screen.findByRole('list', { name: 'Needs my decision' });

    await user.click(within(pane()).getByRole('button', { name: 'Open PR' }));
    expect(open).toHaveBeenCalledWith(
      'https://github.com/acme/app/pull/7',
      '_blank',
      'noopener,noreferrer',
    );
    await user.click(within(pane()).getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('issue page')).toBeVisible();
    open.mockRestore();
  });

  it('puts the card back and says so when the action fails', async () => {
    const user = userEvent.setup();
    const approval = item({
      id: 'n9',
      type: 'approval_pending',
      title: 'NP-9 needs approval',
      payload: { approvalId: 'ap9', fromStatus: 'in_review', toStatus: 'done' },
    });
    api.request.mockImplementation(
      (options: { path: string; method?: string }) =>
        options.path === 'np/approvals/ap9/approve'
          ? Promise.reject(new Error('offline'))
          : withDecisions([approval])(options as never),
    );
    await renderInbox();
    await screen.findByRole('list', { name: 'Needs my decision' });
    await user.click(within(pane()).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      ),
    );
    expect(
      await within(pane()).findByRole('button', { name: 'Approve' }),
    ).toBeEnabled();
  });
});
