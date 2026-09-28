import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NpInboxNavIcon } from '../../client/components/np-inbox-nav-icon.js';
import { answer, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const chime = vi.hoisted(() => ({ play: vi.fn() }));
const realtime = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload?: unknown }) => void>(),
  subscribe: vi.fn(),
  onOpen: vi.fn(() => () => {}),
}));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => realtime,
}));

vi.mock('../../client/pages/np/inbox/inbox-chime.js', async (original) => ({
  ...(await original<
    typeof import('../../client/pages/np/inbox/inbox-chime.js')
  >()),
  playInboxChime: chime.play,
}));

afterEach(() => {
  api.request.mockReset();
  chime.play.mockReset();
  realtime.listeners.clear();
});

realtime.subscribe.mockImplementation(
  (topic: string, listener: (event: { payload?: unknown }) => void) => {
    realtime.listeners.set(topic, listener);
    return () => realtime.listeners.delete(topic);
  },
);

describe('inbox navigation badge', () => {
  it('shows the pending decision count and refreshes on np:inbox', async () => {
    let decision = 3;
    api.request.mockImplementation(
      answer({
        'GET np/inbox/pending-count': () => ({ data: { decision } }),
      }),
    );
    document.title = 'NocoProject';
    const view = await renderNp(<NpInboxNavIcon />);
    expect(await screen.findByTestId('np-inbox-badge')).toHaveTextContent('3');
    expect(screen.getByText('3 pending')).toBeInTheDocument();
    expect(document.title).toBe('(3) NocoProject');

    decision = 120;
    realtime.listeners.get('np:inbox')?.({
      payload: { kind: 'inbox.changed' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('np-inbox-badge')).toHaveTextContent('99+'),
    );
    expect(document.title).toBe('(99+) NocoProject');

    decision = 0;
    realtime.listeners.get('np:inbox')?.({
      payload: { kind: 'inbox.changed' },
    });
    await waitFor(() =>
      expect(screen.queryByTestId('np-inbox-badge')).toBeNull(),
    );
    expect(document.title).toBe('NocoProject');

    decision = 2;
    realtime.listeners.get('np:inbox')?.({
      payload: { kind: 'inbox.changed' },
    });
    await waitFor(() => expect(document.title).toBe('(2) NocoProject'));
    view.unmount();
    expect(document.title).toBe('NocoProject');
  });

  it('shows no badge without pending decisions or when the count fails', async () => {
    api.request.mockImplementation(
      answer({
        'GET np/inbox/pending-count': { data: { decision: 0 } },
      }),
    );
    const view = await renderNp(<NpInboxNavIcon />);
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    expect(screen.queryByTestId('np-inbox-badge')).toBeNull();
    view.unmount();

    api.request.mockRejectedValue(new Error('forbidden'));
    await renderNp(<NpInboxNavIcon />);
    await waitFor(() =>
      expect(
        api.request.mock.calls.filter(
          ([options]) => options.path === 'np/inbox/pending-count',
        ),
      ).toHaveLength(2),
    );
    expect(screen.queryByTestId('np-inbox-badge')).toBeNull();
  });

  it('chimes when the count goes up after the first load', async () => {
    let decision = 2;
    api.request.mockImplementation(
      answer({
        'GET np/inbox/pending-count': () => ({ data: { decision } }),
        'GET np/me/preferences': { data: { inboxChime: true } },
      }),
    );
    await renderNp(<NpInboxNavIcon />);
    expect(await screen.findByTestId('np-inbox-badge')).toHaveTextContent('2');
    expect(chime.play).not.toHaveBeenCalled();

    const push = () =>
      realtime.listeners.get('np:inbox')?.({
        payload: { kind: 'inbox.changed' },
      });
    decision = 3;
    push();
    await waitFor(() =>
      expect(screen.getByTestId('np-inbox-badge')).toHaveTextContent('3'),
    );
    expect(chime.play).toHaveBeenCalledTimes(1);

    decision = 1;
    push();
    await waitFor(() =>
      expect(screen.getByTestId('np-inbox-badge')).toHaveTextContent('1'),
    );
    expect(chime.play).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the member turned the chime off', async () => {
    let decision = 2;
    api.request.mockImplementation(
      answer({
        'GET np/inbox/pending-count': () => ({ data: { decision } }),
        'GET np/me/preferences': { data: { inboxChime: false } },
      }),
    );
    await renderNp(<NpInboxNavIcon />);
    expect(await screen.findByTestId('np-inbox-badge')).toHaveTextContent('2');
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'np/me/preferences' }),
      ),
    );

    decision = 3;
    realtime.listeners.get('np:inbox')?.({
      payload: { kind: 'inbox.changed' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('np-inbox-badge')).toHaveTextContent('3'),
    );
    expect(chime.play).not.toHaveBeenCalled();
  });
});
