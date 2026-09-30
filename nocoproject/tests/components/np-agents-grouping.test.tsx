import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AgentsPage from '../../client/pages/np/agents/index.js';
import { answer, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));
vi.mock('../../client/pages/np/use-realtime.js', () => ({
  useRealtimeTopic: () => undefined,
}));

afterEach(() => {
  api.request.mockReset();
  localStorage.clear();
});

const agent = (id: string, runtimeId: string | null) => ({
  id,
  name: `Agent ${id}`,
  provider: 'claude',
  runtimeId,
  runtimeName: runtimeId ? `${runtimeId} (claude)` : null,
  runtimeStatus: 'online',
});
const runtime = (id: string, daemonId: string, device: string) => ({
  id,
  daemonId,
  name: `${device} (claude)`,
  provider: 'claude',
  kind: 'personal',
  status: 'online',
  lastSeenAt: new Date().toISOString(),
  deviceInfo: { deviceName: device },
  ownerName: 'Alice',
});

describe('agents grouped by computer (NP-188)', () => {
  it('switches from the list to groups by computer and remembers the choice', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        'GET np/agents': {
          data: [
            agent('a1', 'r1'),
            agent('a2', 'r2'),
            agent('a3', 'r3'),
            agent('a4', null),
          ],
        },
        'GET np/runtimes': {
          data: [
            runtime('r1', 'd1', 'studio.local'),
            runtime('r2', 'd1', 'studio.local'),
            runtime('r3', 'd2', 'laptop.local'),
          ],
        },
        'GET np/computers': { data: [] },
      }),
    );
    const { unmount } = await renderNp(<AgentsPage />, { url: '/agents' });

    const table = await screen.findByRole('table');
    expect(table.querySelector('[data-group]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'By computer' }));
    const grouped = await screen.findByRole('table');
    await within(grouped).findByText('studio.local');
    const groups = [...grouped.querySelectorAll('[data-group]')];
    expect(groups.map((row) => row.getAttribute('data-group'))).toEqual([
      'd2',
      'd1',
      'none',
    ]);
    expect(groups[1]).toHaveTextContent('2 agents');
    expect(groups[2]).toHaveTextContent('No computer');
    // Each group's agents follow its header row.
    expect(groups[1]!.nextElementSibling).toHaveTextContent('Agent a1');
    expect(groups[2]!.nextElementSibling).toHaveTextContent('Agent a4');

    unmount();
    await renderNp(<AgentsPage />, { url: '/agents' });
    expect(
      await screen.findByRole('button', { name: 'By computer' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
