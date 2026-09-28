import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import GeneralConfigTab from '../../client/pages/np/config/general.js';
import { answer, type RequestOptions, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));
const chime = vi.hoisted(() => ({ play: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => ({ subscribe: () => () => {}, onOpen: () => () => {} }),
}));
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('../../client/pages/np/inbox/inbox-chime.js', async (original) => ({
  ...(await original<
    typeof import('../../client/pages/np/inbox/inbox-chime.js')
  >()),
  playInboxChime: chime.play,
}));

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
  chime.play.mockReset();
});

function readOnlyMember(
  routes: Record<string, unknown>,
): (options: RequestOptions) => Promise<unknown> {
  return answer({
    'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
    'GET np/members': {
      data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'member' }],
    },
    'GET np/settings': { data: { canEdit: false } },
    'GET np/workflows': { data: [] },
    ...routes,
  });
}

describe('sound reminder in settings (NP-108)', () => {
  it('lets a read-only member turn the chime off and on, saved to the account', async () => {
    const user = userEvent.setup();
    const patched: unknown[] = [];
    api.request.mockImplementation(
      readOnlyMember({
        'GET np/me/preferences': { data: { inboxChime: true } },
        'PATCH np/me/preferences': (options: RequestOptions) => {
          patched.push(options.json);
          return { data: options.json };
        },
      }),
    );
    await renderNp(<GeneralConfigTab />);

    expect(
      await screen.findByRole('heading', { name: 'My reminders' }),
    ).toBeVisible();
    const toggle = screen.getByRole('switch', { name: 'Sound reminder' });
    await waitFor(() => expect(toggle).not.toHaveAttribute('data-disabled'));
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);
    await waitFor(() => expect(patched).toEqual([{ inboxChime: false }]));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          title: 'Sound reminder turned off.',
        }),
      ),
    );
    expect(chime.play).not.toHaveBeenCalled();

    await waitFor(() => expect(toggle).not.toHaveAttribute('data-disabled'));
    await user.click(toggle);
    await waitFor(() =>
      expect(patched).toEqual([{ inboxChime: false }, { inboxChime: true }]),
    );
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(chime.play).toHaveBeenCalledWith({ preview: true });
  });

  it('shows the saved choice and puts the switch back when saving fails', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      readOnlyMember({
        'GET np/me/preferences': { data: { inboxChime: false } },
        'PATCH np/me/preferences': () => Promise.reject(new Error('offline')),
      }),
    );
    await renderNp(<GeneralConfigTab />);
    const toggle = await screen.findByRole('switch', {
      name: 'Sound reminder',
    });
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-checked', 'false'),
    );

    await user.click(toggle);
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      ),
    );
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
