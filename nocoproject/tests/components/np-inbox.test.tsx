import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  group,
  item,
  pane,
  renderInbox,
  respond,
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

describe('inbox', () => {
  it('groups decisions before notifications, with pending and unread counts on the filters', async () => {
    api.request.mockImplementation(respond);
    await renderInbox();

    const decisions = await screen.findByRole('list', {
      name: 'Needs my decision',
    });
    const decisionTab = screen.getByRole('tab', { name: /Needs my decision/ });
    // The decision tab shows the pending count, the same as the navigation badge, not the unread count (NP-180).
    expect(
      await within(decisionTab).findByLabelText('2 pending'),
    ).toBeVisible();
    const infoTab = screen.getByRole('tab', { name: /Notifications/ });
    expect(within(infoTab).getByLabelText('4 unread')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Unread cards say so; merged cards show how many events they carry.
    const [first, second] = within(decisions).getAllByRole('listitem');
    expect(within(first).getByText('Unread')).toBeInTheDocument();
    expect(within(first).getByText('Review requested')).toBeVisible();
    expect(within(second).queryByText('Unread')).toBeNull();
    expect(within(second).getByText('×3')).toBeVisible();
    // Notifications follow in their own group.
    expect(
      within(group('Notifications')).getByText('New comment on NP-1'),
    ).toBeVisible();
    // The detail pane shows the first item until another is chosen.
    expect(
      within(pane()).getByRole('heading', { name: 'NP-1 is ready for review' }),
    ).toBeVisible();

    expect(realtime.subscribe.mock.calls.map((call) => call[0])).toContain(
      'np:inbox',
    );
  });

  it('filters to notifications through the tab', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(respond);
    await renderInbox();
    await screen.findByRole('list', { name: 'Needs my decision' });

    await user.click(screen.getByRole('tab', { name: /Notifications/ }));
    expect(
      await screen.findByRole('list', { name: 'Notifications' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('list', { name: 'Needs my decision' }),
    ).toBeNull();
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/inbox',
        query: { kind: 'info', archived: 'false' },
      }),
    );
  });

  it('shows the delivery in full beside the list, marks the card read, and opens the issue', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(respond);
    await renderInbox();

    const decisions = await screen.findByRole('list', {
      name: 'Needs my decision',
    });
    await user.click(within(decisions).getByText('NP-1 is ready for review'));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'np/inbox/n1/read', method: 'POST' }),
      ),
    );
    // The agent's delivery note (in full) and the issue's latest activity are right there.
    expect(await within(pane()).findByText('delivery note')).toBeVisible();
    expect(
      within(pane()).getAllByText(
        'Implemented the endpoint and added tests.',
      )[0],
    ).toBeVisible();
    expect(within(pane()).getByText('Latest activity')).toBeVisible();
    expect(within(pane()).getAllByText('In review').length).toBeGreaterThan(0);

    await user.click(
      within(pane()).getByRole('button', { name: 'Open issue' }),
    );
    expect(await screen.findByText('issue page')).toBeVisible();
  });

  it('moves with j / k, archives with e and opens with Enter', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(respond);
    await renderInbox();
    await screen.findByRole('list', { name: 'Needs my decision' });

    await user.keyboard('j');
    expect(
      await within(pane()).findByRole('heading', {
        name: 'Executor proposals on NP-2',
      }),
    ).toBeVisible();
    await user.keyboard('k');
    expect(
      await within(pane()).findByRole('heading', {
        name: 'NP-1 is ready for review',
      }),
    ).toBeVisible();
    await user.keyboard('e');
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/inbox/n1/archive',
          method: 'POST',
        }),
      ),
    );
    await user.keyboard('{Enter}');
    expect(await screen.findByText('issue page')).toBeVisible();
  });

  it('archives from the card menu and marks everything read', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(respond);
    await renderInbox();
    await screen.findByRole('list', { name: 'Needs my decision' });

    await user.click(
      within(group('Needs my decision')).getByRole('button', {
        name: 'Actions for NP-1 is ready for review',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/inbox/n1/archive',
          method: 'POST',
        }),
      ),
    );

    await user.click(screen.getByRole('button', { name: /Mark all as read/ }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/inbox/read-all',
          method: 'POST',
          json: {},
        }),
      ),
    );
  });

  it('renders iteration 2 cards from type and payload, falling back to the English body', async () => {
    const approval = item({
      id: 'n4',
      type: 'approval_pending',
      issueId: '104',
      issueIdentifier: 'NP-4',
      title: 'NP-4 Ship the release',
      body: 'Approval requested (English fallback)',
      actorName: 'Claude Coder',
      payload: { fromStatus: 'in_review', toStatus: 'done', requestId: 'ap1' },
    });
    const prReview = item({
      id: 'n5',
      type: 'pr_review',
      issueId: '105',
      title: 'NP-5 Fix login',
      body: 'PR is ready (English fallback)',
      payload: { repo: 'acme/app', number: 42 },
    });
    const bare = item({
      id: 'n6',
      type: 'pr_merged',
      title: 'NP-6 Docs',
      body: 'A PR was merged (English fallback)',
      payload: {},
    });
    api.request.mockImplementation(withDecisions([approval, prReview, bare]));
    await renderInbox();

    const decisions = await screen.findByRole('list', {
      name: 'Needs my decision',
    });
    expect(
      within(decisions).getByText(
        'Claude Coder asks to move it from In review to Done.',
      ),
    ).toBeVisible();
    expect(within(decisions).getByText('Approval requested')).toBeVisible();
    expect(
      within(decisions).getByText('PR acme/app#42 is ready to merge.'),
    ).toBeVisible();
    expect(within(decisions).getByText('PR ready to merge')).toBeVisible();
    expect(
      within(decisions).getByText('A PR was merged (English fallback)'),
    ).toBeVisible();
    // The approval's change is spelled out in the detail pane, beside its actions.
    expect(within(pane()).getByText('Requested by')).toBeVisible();
    expect(within(pane()).getByText('Done')).toBeVisible();
    expect(
      within(pane()).getByRole('button', { name: 'Approve' }),
    ).toBeVisible();
  });
});
