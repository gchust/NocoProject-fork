import { ApiClientError } from '@nocobase/app-client';
import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import locales from '../../client/locales/index.js';
import InvitePage from '../../client/pages/auth/invite.js';
import MembersSettingsPage from '../../client/pages/np/config/members.js';

/**
 * NP-88 in the browser: the "Invite members" entry on the members tab (owner/admin, and project leads for their projects),
 * the dialog's validation and per-address results with the link to copy, the pending list with revoke, and the
 * public acceptance page (lookup, accept, sign-in; refused and signed-in states).
 */

const api = vi.hoisted(() => ({ request: vi.fn() }));
const auth = vi.hoisted(() => ({
  session: null as null | { user: { name: string; email: string } },
  login: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

vi.mock('@nocobase/app-plugin-authentication/client', () => ({
  useSignUpAvailable: () => false,
  useAuthentication: () => ({
    session: auth.session,
    isPending: false,
    client: { signOut: auth.signOut },
    refresh: vi.fn(),
  }),
}));

vi.mock('@nocobase/app-plugin-authentication/client/actions', () => ({
  usePasswordLogin: () => ({ isPending: false, submit: auth.login }),
}));

const MEMBERS = [
  { userId: 'u1', name: 'Olivia Owner', email: 'o@example.com', role: 'owner' },
  { userId: 'u3', name: 'Mia Member', email: null, role: 'member' },
];
const PROJECTS = [
  { id: 'p1', name: 'Launch', leadUserId: 'u3' },
  { id: 'p2', name: 'Ops', leadUserId: 'u1' },
];
const PENDING = [
  {
    id: 'i1',
    email: 'pending@example.com',
    status: 'pending',
    projects: [{ id: 'p1', name: 'Launch' }],
    invitedBy: { userId: 'u1', name: 'Olivia Owner' },
    expiresAt: '2026-10-05T00:00:00.000Z',
    sentAt: '2026-09-28T00:00:00.000Z',
    createdAt: '2026-09-28T00:00:00.000Z',
  },
];

async function renderWith(element: ReactElement, path = '/') {
  const runtime = new I18nRuntime({
    defaultLocale: 'en-US',
    locales: ['en-US', 'zh-CN'],
    applicationNamespace: 'test-app',
  });
  runtime.registerApplicationNamespace('test-app', locales);
  await runtime.init('en-US');
  render(
    <I18nProvider runtime={runtime}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path='/' element={<div>Home</div>} />
            <Route path='/members' element={element} />
            <Route path='/invite/:token' element={element} />
            <Route path='/login' element={<div>Login page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function membersApi(
  userId: string,
  created: unknown[] = [],
  projects: readonly unknown[] = PROJECTS,
): void {
  api.request.mockImplementation(
    (options: { path: string; method?: string; json?: unknown }) => {
      if (options.path === 'np/me')
        return Promise.resolve({ data: { userId, name: userId } });
      if (options.path === 'np/members')
        return Promise.resolve({ data: MEMBERS });
      if (options.path === 'np/projects')
        return Promise.resolve({ data: projects });
      if (options.path === 'np/invitations' && options.method === 'POST') {
        created.push(options.json);
        return Promise.resolve({
          data: {
            results: [
              {
                email: 'new@example.com',
                outcome: 'invited',
                emailSent: false,
                inviteUrl: 'https://np.example.com/main/invite/tok',
              },
              { email: 'bob@example.com', outcome: 'added' },
            ],
          },
        });
      }
      if (options.path === 'np/invitations')
        return Promise.resolve({ data: PENDING });
      return Promise.resolve({ data: undefined });
    },
  );
}

afterEach(() => {
  api.request.mockReset();
  auth.login.mockReset();
  auth.signOut.mockReset();
  auth.session = null;
});

describe('inviting members', () => {
  it('offers no invitation to a member who leads no project', async () => {
    membersApi('u3', [], [{ id: 'p1', name: 'Launch', leadUserId: 'u1' }]);
    await renderWith(<MembersSettingsPage />, '/members');
    await screen.findByText('Mia Member');
    await screen.findAllByText('Olivia Owner');
    expect(
      screen.queryByRole('button', { name: 'Invite members' }),
    ).not.toBeInTheDocument();
  });

  it('requires a project from a project lead', async () => {
    membersApi('u3');
    await renderWith(<MembersSettingsPage />, '/members');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Invite members' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Email addresses'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send invitations' }),
    );
    expect(
      await within(dialog).findByText('Choose at least one project you lead.'),
    ).toBeVisible();
    expect(api.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'np/invitations', method: 'POST' }),
    );
  });

  it('sends several addresses and shows each outcome with the link to copy', async () => {
    const created: unknown[] = [];
    membersApi('u1', created);
    await renderWith(<MembersSettingsPage />, '/members');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Invite members' }),
    );
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('Email addresses');
    fireEvent.change(field, { target: { value: 'not-an-email' } });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send invitations' }),
    );
    expect(
      await within(dialog).findByText(
        'Not a valid email address: not-an-email',
      ),
    ).toBeVisible();

    fireEvent.change(field, {
      target: { value: 'New@example.com, bob@example.com\nnew@example.com' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send invitations' }),
    );
    expect(
      await within(dialog).findByText('Email not sent — copy the link'),
    ).toBeVisible();
    expect(created).toEqual([
      { emails: ['new@example.com', 'bob@example.com'], projectIds: [] },
    ]);
    expect(
      within(dialog).getByText('Has an account — added to the projects'),
    ).toBeVisible();
    expect(within(dialog).getByLabelText('Invitation link')).toHaveValue(
      'https://np.example.com/main/invite/tok',
    );
  });

  it('lists pending invitations and revokes after confirmation', async () => {
    membersApi('u1');
    await renderWith(<MembersSettingsPage />, '/members');
    expect(await screen.findByText('pending@example.com')).toBeVisible();
    expect(screen.getByText('Pending invitations')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await vi.waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/invitations/i1',
          method: 'DELETE',
        }),
      ),
    );
  });
});

describe('the invitation page', () => {
  const lookup = {
    email: 'new@example.com',
    inviterName: 'Olivia Owner',
    projectNames: ['Launch'],
    expiresAt: '2026-10-05T00:00:00.000Z',
  };

  it('creates the account and signs in with the chosen password', async () => {
    api.request.mockImplementation(
      (options: { path: string; json?: unknown }) =>
        Promise.resolve(
          options.path === 'np/public/invitations/lookup'
            ? { data: lookup }
            : { data: { email: 'new@example.com', existingAccount: false } },
        ),
    );
    await renderWith(<InvitePage />, '/invite/tok');
    expect(
      await screen.findByText(
        'Olivia Owner invited you to NocoProject and the projects Launch.',
      ),
    ).toBeVisible();
    expect(screen.getByLabelText('Email')).toHaveValue('new@example.com');
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'New Person' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'short' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(
      await screen.findByText('The password needs at least 8 characters.'),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'long-enough-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await vi.waitFor(() =>
      expect(auth.login).toHaveBeenCalledWith({
        identifier: 'new@example.com',
        password: 'long-enough-1',
      }),
    );
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/public/invitations/accept',
        json: { token: 'tok', name: 'New Person', password: 'long-enough-1' },
      }),
    );
  });

  it('explains an expired invitation', async () => {
    api.request.mockRejectedValue(
      new ApiClientError('expired', {
        status: 409,
        code: 'INVITATION_EXPIRED',
        method: 'POST',
        url: '/api/np/public/invitations/lookup',
      }),
    );
    await renderWith(<InvitePage />, '/invite/tok');
    expect(
      await screen.findByText(
        'This invitation has expired. Ask for a new invitation.',
      ),
    ).toBeVisible();
  });

  it('asks a signed-in visitor to sign out first', async () => {
    auth.session = { user: { name: 'Someone', email: 's@example.com' } };
    api.request.mockResolvedValue({ data: lookup });
    await renderWith(<InvitePage />, '/invite/tok');
    expect(
      await screen.findByText(
        'You are signed in as Someone. Sign out to accept this invitation.',
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});
