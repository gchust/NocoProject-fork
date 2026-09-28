import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import locales from '../../client/locales/index.js';
import MembersSettingsPage from '../../client/pages/np/config/members.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const MEMBERS = [
  { userId: 'u1', name: 'Olivia Owner', email: 'o@example.com', role: 'owner' },
  { userId: 'u2', name: 'Adam Admin', email: null, role: 'admin' },
  { userId: 'u3', name: 'Mia Member', email: null, role: 'member' },
];

async function renderAs(userId: string) {
  api.request.mockImplementation((options: { path: string }) =>
    Promise.resolve(
      options.path === 'np/me'
        ? { data: { userId, name: userId } }
        : options.path === 'np/members'
          ? { data: MEMBERS }
          : { data: [] },
    ),
  );
  const runtime = new I18nRuntime({
    defaultLocale: 'en-US',
    locales: ['en-US', 'zh-CN'],
    applicationNamespace: 'test-app',
  });
  runtime.registerApplicationNamespace('test-app', locales);
  await runtime.init('en-US');
  render(
    <I18nProvider runtime={runtime}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MembersSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
  await screen.findByText('Mia Member');
}

const roleSelect = (name: string) =>
  screen.getByRole('combobox', { name: `Role of ${name}` });

afterEach(() => api.request.mockReset());

describe('members settings', () => {
  it('lets a member change no role', async () => {
    await renderAs('u3');
    await vi.waitFor(() => expect(roleSelect('Mia Member')).toBeDisabled());
    expect(roleSelect('Adam Admin')).toBeDisabled();
    expect(roleSelect('Olivia Owner')).toBeDisabled();
  });

  it('lets an admin change members and admins but not the owner', async () => {
    await renderAs('u2');
    await vi.waitFor(() => expect(roleSelect('Mia Member')).toBeEnabled());
    expect(roleSelect('Adam Admin')).toBeEnabled();
    // The only owner can be demoted by nobody.
    expect(roleSelect('Olivia Owner')).toBeDisabled();
  });
});
