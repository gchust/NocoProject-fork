import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authzDouble } from './np-authz-double.js';

import { ResourcesSection } from '../../client/pages/np/projects/detail/resources-section.js';
import { GithubWebhookGuide } from '../../client/pages/np/projects/detail/webhook-guide.js';
import type { ProjectResource } from '../../client/pages/np/types.js';
import { answer, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
});

const members = (role: 'owner' | 'member') => {
  authzDouble.as(role);
  return {
    'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
    'GET np/members': {
      data: [{ userId: 'u1', name: 'Zhou', email: null, role }],
    },
  };
};

const resource = (id: string, url: string): ProjectResource => ({
  id,
  projectId: 'p1',
  type: 'gitRepo',
  url,
  defaultRef: null,
  label: null,
  position: Number(id),
});

describe('GitHub webhook guide for project repositories (NP-118)', () => {
  it('opens the steps for a GitHub repository with the webhook URL for an admin', async () => {
    api.request.mockImplementation(
      answer({
        ...members('owner'),
        'GET np/integrations/github': {
          data: {
            apiBaseUrl: 'https://api.github.com',
            tokenSet: true,
            webhookSecretSet: false,
            webhookUrl: 'https://np.example.com/np/webhooks/github',
            lastEventAt: null,
          },
        },
      }),
    );
    await renderNp(
      <ResourcesSection
        projectId='p1'
        canEdit
        resources={[
          resource('1', 'git@github.com:nocobase/nocoitam.git'),
          resource('2', 'https://gitlab.com/acme/tool.git'),
        ]}
      />,
    );
    expect(
      screen.queryByRole('button', {
        name: 'Webhook setup for https://gitlab.com/acme/tool.git',
      }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Webhook setup for git@github.com:nocobase/nocoitam.git',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Add the webhook on GitHub')).toBeVisible();
    expect(
      within(dialog).getByRole('link', { name: 'Open on GitHub' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/nocobase/nocoitam/settings/hooks/new',
    );
    expect(
      await within(dialog).findByText(
        'https://np.example.com/np/webhooks/github',
      ),
    ).toBeVisible();
    expect(within(dialog).getByText('application/json')).toBeVisible();
    expect(within(dialog).getByText('Secret not set')).toBeVisible();
    expect(
      within(dialog).getAllByRole('link', { name: 'Settings → GitHub' })[0],
    ).toHaveAttribute('href', '/config/github');
  });

  it('points a member at an admin without requesting the admin-only connection', async () => {
    api.request.mockImplementation(answer(members('member')));
    await renderNp(
      <GithubWebhookGuide repoUrl='https://github.com/nocobase/NocoProject.git' />,
    );
    expect(
      await screen.findByText(
        'Ask a workspace owner or admin: it is under Settings → GitHub.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('Open the webhook settings of nocobase/NocoProject.'),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        api.request.mock.calls.some(
          ([options]) =>
            (options as { path: string }).path === 'np/integrations/github',
        ),
      ).toBe(false),
    );
  });
});
