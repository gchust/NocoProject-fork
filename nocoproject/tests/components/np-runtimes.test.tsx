import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_VERSION } from '../../client/pages/np/constants.js';
import RuntimesPage from '../../client/pages/np/runtimes/index.js';
import { renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const runtime = (
  id: string,
  status: string,
  daemon: Record<string, unknown> | null,
) => ({
  id,
  name: `${id} (claude)`,
  provider: 'claude',
  kind: 'personal',
  status,
  lastSeenAt: new Date().toISOString(),
  version: '2.1.0',
  deviceInfo: { deviceName: `${id}-mac` },
  daemon,
});

// The page subscribes to `np:agents`; the realtime client is not part of this test.
vi.mock('../../client/pages/np/use-realtime.js', () => ({
  useRealtimeTopic: () => undefined,
}));

afterEach(() => api.request.mockReset());

describe('runtimes page (NP-150)', () => {
  it('shows an old daemon as "upgrade required" with its command, and flags a CLI behind the served one', async () => {
    const user = userEvent.setup();
    api.request.mockResolvedValue({
      data: [
        runtime('old', 'upgrade_required', {
          version: '0.3.2',
          status: 'unsupported',
          updateAvailable: true,
          latestVersion: CLI_VERSION,
        }),
        runtime('window', 'online', {
          version: '0.4.0',
          status: 'deprecated',
          updateAvailable: true,
          latestVersion: CLI_VERSION,
        }),
        runtime('current', 'online', {
          version: CLI_VERSION,
          status: 'ok',
          updateAvailable: false,
          latestVersion: CLI_VERSION,
        }),
      ],
    });
    await renderNp(<RuntimesPage />, { url: '/runtimes' });

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    const row = (name: string) =>
      rows.find((item) => item.textContent?.includes(`${name} (claude)`));
    const [old, window, current] = [row('old'), row('window'), row('current')];
    expect(old).toHaveTextContent('Upgrade required');
    expect(old).not.toHaveTextContent('Offline');
    expect(window).toHaveTextContent('Online');
    expect(current).toHaveTextContent(CLI_VERSION);
    expect(
      within(current!).queryByRole('button', {
        name: 'Show the upgrade command',
      }),
    ).toBeNull();

    await user.click(
      within(old!).getByRole('button', { name: 'Show the upgrade command' }),
    );
    expect(
      await screen.findByText('Upgrade the CLI on old-mac'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        new RegExp(
          `^npm i -g .*/assets/cli/nocoproject-cli-${CLI_VERSION.replace(/\./gu, '\\.')}\\.tgz && nocoproject daemon install$`,
          'u',
        ),
      ),
    ).toBeInTheDocument();
  });
});
