import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_VERSION } from '../../client/pages/np/constants.js';
import RuntimesPage from '../../client/pages/np/runtimes/index.js';
import { answer, renderNp } from './np-harness.js';

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
  daemonId: `${id}-d`,
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
vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);
vi.mock('@/components/ui/toast', () => ({ toast: { add: vi.fn() } }));
vi.mock('../../client/pages/np/use-realtime.js', () => ({
  useRealtimeTopic: () => undefined,
}));

afterEach(() => api.request.mockReset());

describe('runtimes page (NP-150)', () => {
  it('shows an old daemon as "upgrade required" with its command, and flags a CLI behind the served one', async () => {
    const user = userEvent.setup();
    const runtimes = {
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
        {
          ...runtime('legacy', 'online', {
            version: CLI_VERSION,
            status: 'ok',
            updateAvailable: false,
            latestVersion: CLI_VERSION,
            credential: 'personalKey',
          }),
        },
      ],
    };
    api.request.mockImplementation(
      answer({
        'GET np/runtimes': runtimes,
        'GET np/computers': {
          data: [
            {
              id: 'c1',
              ownerUserId: 'u1',
              ownerName: 'Alice',
              name: 'Studio',
              keyStart: 'npc_ab',
              daemonId: 'd1',
              deviceName: 'studio.local',
              lastUsedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              revokedAt: null,
              canRevoke: true,
            },
          ],
        },
        'DELETE np/computers/c1': {
          data: {
            id: 'c1',
            name: 'Studio',
            revokedAt: new Date().toISOString(),
          },
        },
      }),
    );
    await renderNp(<RuntimesPage />, { url: '/runtimes' });

    await screen.findByText('old-mac');
    const [table] = screen.getAllByRole('table');
    // NP-188: one group row per computer (its CLI in the header), its runtimes right under it.
    const header = (name: string) =>
      table!.querySelector<HTMLElement>(`[data-group="${name}-d"]`)!;
    const row = (name: string) =>
      header(name).nextElementSibling as HTMLElement;
    const [old, window] = [row('old'), row('window')];
    expect(old).toHaveTextContent('Upgrade required');
    expect(old).not.toHaveTextContent('Offline');
    expect(window).toHaveTextContent('Online');
    expect(header('current')).toHaveTextContent(CLI_VERSION);
    expect(
      within(header('current')).queryByRole('button', {
        name: 'Show the upgrade command',
      }),
    ).toBeNull();

    await user.click(
      within(header('old')).getByRole('button', {
        name: 'Show the upgrade command',
      }),
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
    expect(header('legacy')).toHaveTextContent('Personal API key');

    // The computer credentials: revoking asks first, then calls the API.
    await user.keyboard('{Escape}');
    const computers = within(
      screen.getByRole('region', { name: 'Computer credentials' }),
    );
    expect(computers.getByText('npc_ab…')).toBeInTheDocument();
    await user.click(computers.getByRole('button', { name: 'Revoke' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke',
      }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'np/computers/c1', method: 'DELETE' }),
      ),
    );
  });
});

describe('runtimes grouped by computer (NP-188)', () => {
  const computer = (
    id: string,
    daemonId: string,
    revokedAt: string | null,
  ) => ({
    id,
    ownerUserId: 'u1',
    ownerName: 'Alice',
    name: `Computer ${id}`,
    keyStart: `npc_${id}`,
    daemonId,
    deviceName: null,
    lastUsedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    revokedAt,
    canRevoke: !revokedAt,
  });

  it('puts a computer’s runtimes under one row named after its credential, and folds revoked credentials apart', async () => {
    const user = userEvent.setup();
    const sameDaemon = (id: string, provider: string) => ({
      ...runtime(id, 'online', null),
      daemonId: 'studio',
      provider,
      deviceInfo: { deviceName: 'studio.local' },
    });
    api.request.mockImplementation(
      answer({
        'GET np/runtimes': {
          data: [
            sameDaemon('r1', 'claude'),
            sameDaemon('r2', 'codex'),
            runtime('other', 'offline', null),
          ],
        },
        'GET np/computers': {
          data: [
            computer('old', 'studio', new Date().toISOString()),
            computer('new', 'studio', null),
            computer('gone', 'gone-d', new Date().toISOString()),
          ],
        },
      }),
    );
    await renderNp(<RuntimesPage />, { url: '/runtimes' });

    const [table] = await screen.findAllByRole('table');
    const groups = table!.querySelectorAll('[data-group]');
    // The computer with a runtime online comes first; the active credential names it.
    expect([...groups].map((row) => row.getAttribute('data-group'))).toEqual([
      'studio',
      'other-d',
    ]);
    expect(groups[0]).toHaveTextContent('Computer new');
    expect(groups[0]).toHaveTextContent('studio.local');
    expect(groups[0]).toHaveTextContent('2 runtimes');
    expect(groups[1]).toHaveTextContent('other-mac');
    expect(groups[1]).toHaveTextContent('Offline');

    const region = within(
      screen.getByRole('region', { name: 'Computer credentials' }),
    );
    expect(region.getByText('npc_new…')).toBeInTheDocument();
    expect(region.queryByText('npc_old…')).toBeNull();
    await user.click(region.getByRole('button', { name: 'Revoked (2)' }));
    expect(region.getByText('npc_old…')).toBeInTheDocument();
    expect(region.getByText('npc_gone…')).toBeInTheDocument();
    expect(region.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });
});
