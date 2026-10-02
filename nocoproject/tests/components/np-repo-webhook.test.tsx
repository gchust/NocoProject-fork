import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authzDouble } from './np-authz-double.js';

import GithubConfigTab from '../../client/pages/np/config/github.js';
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

  it('lets an admin copy the saved secret from the steps (NP-227)', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        ...members('owner'),
        'GET np/integrations/github': {
          data: {
            apiBaseUrl: 'https://api.github.com',
            tokenSet: true,
            webhookSecretSet: true,
            webhookUrl: 'https://np.example.com/np/webhooks/github',
            lastEventAt: null,
          },
        },
        'POST np/integrations/github/webhook-secret/reveal': {
          data: { webhookSecret: 'whsec-saved' },
        },
      }),
    );
    await renderNp(
      <GithubWebhookGuide repoUrl='https://github.com/nocobase/NocoProject.git' />,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Show saved secret' }),
    );
    expect(await screen.findByText('whsec-saved')).toBeVisible();
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

describe('token access to a new repository (NP-228)', () => {
  const connection = (tokenSet: boolean) => ({
    'GET np/integrations/github': {
      data: {
        apiBaseUrl: 'https://api.github.com',
        tokenSet,
        webhookSecretSet: true,
        webhookUrl: 'https://np.example.com/np/webhooks/github',
        lastEventAt: null,
      },
    },
  });

  it('lets an admin check what the token may do in the repository', async () => {
    const user = userEvent.setup();
    const access = ['write', 'read', 'none'];
    const test = vi.fn(() => ({
      data: {
        ok: true,
        login: 'octo',
        repo: { fullName: 'nocobase/nocoitam', access: access.shift() },
      },
    }));
    api.request.mockImplementation(
      answer({
        ...members('owner'),
        ...connection(true),
        'POST np/integrations/github/test': test,
      }),
    );
    await renderNp(
      <GithubWebhookGuide repoUrl='git@github.com:nocobase/nocoitam.git' />,
    );
    expect(
      screen.getByText(
        'Make sure NocoProject’s GitHub token can access nocobase/nocoitam: a classic token needs the repo scope; a fine-grained token must list this repository with read access to Pull requests and Commit statuses, plus write access to Contents to merge from NocoProject. When the token cannot read Checks, a refresh reads commit statuses only and check results arrive through the webhook.',
      ),
    ).toBeVisible();
    const check = await screen.findByRole('button', { name: 'Check access' });
    await user.click(check);
    expect(await screen.findByText('Token can read and write')).toBeVisible();
    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({ json: { repo: 'nocobase/nocoitam' } }),
    );
    await user.click(check);
    expect(
      await screen.findByText('Read only: merging from NocoProject fails'),
    ).toBeVisible();
    await user.click(check);
    expect(
      await screen.findByText('Token cannot access this repository'),
    ).toBeVisible();
  });

  it('tells seeing the repository apart from reading its pull requests and CI (NP-229)', async () => {
    const user = userEvent.setup();
    const reads = [
      { pullRequests: false, statuses: false, checks: false },
      { pullRequests: true, statuses: true, checks: false },
      { pullRequests: true, statuses: null, checks: null },
    ];
    api.request.mockImplementation(
      answer({
        ...members('owner'),
        ...connection(true),
        'POST np/integrations/github/test': () => ({
          data: {
            ok: true,
            login: 'octo',
            repo: {
              fullName: 'nocobase/nocoitam',
              access: 'write',
              reads: reads.shift(),
            },
          },
        }),
      }),
    );
    await renderNp(
      <GithubWebhookGuide repoUrl='git@github.com:nocobase/nocoitam.git' />,
    );
    const check = await screen.findByRole('button', { name: 'Check access' });
    await user.click(check);
    expect(
      await screen.findByText(
        'Sees the repository but not its pull requests: Pull requests read access is missing',
      ),
    ).toBeVisible();
    expect(screen.queryByText('Token can read and write')).toBeNull();
    expect(screen.getByText('Cannot read commit statuses')).toBeVisible();
    expect(
      screen.getByText(
        'Cannot read Checks: a refresh reads commit statuses only',
      ),
    ).toBeVisible();
    await user.click(check);
    expect(await screen.findByText('Token can read and write')).toBeVisible();
    expect(screen.queryByText('Cannot read commit statuses')).toBeNull();
    expect(
      screen.getByText(
        'Cannot read Checks: a refresh reads commit statuses only',
      ),
    ).toBeVisible();
    await user.click(check);
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Cannot read Checks: a refresh reads commit statuses only',
        ),
      ).toBeNull(),
    );
    expect(screen.getByText('Token can read and write')).toBeVisible();
  });

  it('says when no token is saved and offers no check', async () => {
    api.request.mockImplementation(
      answer({ ...members('owner'), ...connection(false) }),
    );
    await renderNp(
      <GithubWebhookGuide repoUrl='https://github.com/nocobase/NocoProject.git' />,
    );
    expect(await screen.findByText('Token not set')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check access' })).toBeNull();
  });

  it('shows a member the step without the check', async () => {
    api.request.mockImplementation(answer(members('member')));
    await renderNp(
      <GithubWebhookGuide repoUrl='https://github.com/nocobase/NocoProject.git' />,
    );
    expect(
      await screen.findByText(
        'Make sure NocoProject’s GitHub token can access nocobase/NocoProject: a classic token needs the repo scope; a fine-grained token must list this repository with read access to Pull requests and Commit statuses, plus write access to Contents to merge from NocoProject. When the token cannot read Checks, a refresh reads commit statuses only and check results arrive through the webhook.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check access' })).toBeNull();
  });
});

describe('showing the saved webhook secret (NP-227)', () => {
  it('shows it on request in Settings → GitHub and hides it again', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        ...members('owner'),
        'GET np/integrations/github': {
          data: {
            configured: true,
            apiBaseUrl: 'https://api.github.com',
            tokenSet: true,
            webhookSecretSet: true,
            webhookUrl: 'https://np.example.com/np/webhooks/github',
            lastEventAt: null,
          },
        },
        'POST np/integrations/github/webhook-secret/reveal': {
          data: { webhookSecret: 'whsec-saved' },
        },
      }),
    );
    await renderNp(<GithubConfigTab />);
    await user.click(
      await screen.findByRole('button', { name: 'Show saved secret' }),
    );
    expect(await screen.findByText('whsec-saved')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Hide saved secret' }));
    expect(screen.queryByText('whsec-saved')).toBeNull();
  });
});
