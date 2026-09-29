import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authzDouble } from './np-authz-double.js';
import {
  answer,
  type RequestOptions,
  renderNp,
  renderNpRoutes,
} from './np-harness.js';

import MembersConfigTab from '../../client/pages/np/config/members.js';
import RoleDetailPage from '../../client/pages/np/config/role-detail.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const MEMBERS = [
  { userId: 'u1', name: 'Olivia Owner', email: 'o@example.com', role: 'owner' },
  { userId: 'u2', name: 'Adam Admin', email: null, role: 'admin' },
  { userId: 'u3', name: 'Mia Member', email: null, role: 'member' },
];

const title = (key: string) => ({ key: `np.access.sets.${key}`, ns: 'test' });
const role = (
  key: string,
  holderIds: string[],
  extra: Record<string, unknown> = {},
) => ({
  key,
  title: title(key.replace('np-', '')),
  builtIn: true,
  editable: key !== 'np-owner',
  hasForeignGrants: false,
  grants: [],
  holderIds,
  holderCount: holderIds.length,
  ...extra,
});

const ROLES = [
  role('np-owner', ['u1']),
  role('np-admin', ['u2']),
  role('np-member', ['u1', 'u2', 'u3']),
  role('np-r-1', [], { title: 'Observer', builtIn: false }),
  role('np-r-2', ['u2'], {
    title: 'Ops',
    builtIn: false,
    hasForeignGrants: true,
  }),
];

const CATALOG = {
  pages: ['np-issues', 'np-projects'],
  settings: [
    {
      id: 'nocoproject.members',
      title: { key: 'np.access.settings.members', ns: 'test' },
      actions: [
        { name: 'read', title: { key: 'np.access.actions.read', ns: 'test' } },
        {
          name: 'define-roles',
          title: { key: 'np.access.actions.define-roles', ns: 'test' },
        },
      ],
    },
  ],
  business: [
    {
      id: 'nocoproject.issues',
      title: { key: 'np.access.business.issues', ns: 'test' },
      actions: [
        {
          name: 'view',
          title: { key: 'np.access.business.view', ns: 'test' },
          scopes: [
            {
              key: 'issues',
              title: null,
              options: ['nocoproject.visible', 'allRecords'],
              defaultValue: 'nocoproject.visible',
            },
          ],
        },
        {
          name: 'close',
          title: { key: 'np.access.business.close', ns: 'test' },
          scopes: [
            {
              key: 'issues',
              title: null,
              options: ['nocoproject.managed', 'allRecords'],
              defaultValue: 'nocoproject.managed',
            },
          ],
        },
      ],
    },
  ],
  recordAccess: [
    { key: 'allRecords', title: null },
    {
      key: 'nocoproject.visible',
      title: { key: 'np.access.recordAccess.visible', ns: 'test' },
    },
    {
      key: 'nocoproject.managed',
      title: { key: 'np.access.recordAccess.managed', ns: 'test' },
    },
  ],
};

function membersApi(
  userId: string,
  extra: Record<string, unknown | ((options: RequestOptions) => unknown)> = {},
): void {
  authzDouble.as(MEMBERS.find((m) => m.userId === userId)!.role as never);
  api.request.mockImplementation(
    answer({
      'GET np/me': { data: { userId, name: userId } },
      'GET np/members': { data: MEMBERS },
      'GET np/access/roles': { data: ROLES },
      'GET np/access/catalog': { data: CATALOG },
      'GET np/projects': { data: [] },
      'GET np/invitations': { data: [] },
      ...extra,
    }),
  );
}

function membersRoutes() {
  return (
    <Route path='/config/members' element={<MembersConfigTab />}>
      <Route path='roles/:roleKey' element={<RoleDetailPage />} />
    </Route>
  );
}

/** Base UI switches and checkboxes mark a disabled control with `data-disabled`. */
const disabled = (element: HTMLElement) =>
  element.hasAttribute('data-disabled') ||
  element.getAttribute('aria-disabled') === 'true';

const rolesOf = (name: string) =>
  screen.getByRole('combobox', { name: `Roles of ${name}` });

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
  authzDouble.as('member');
});

describe('members and their roles (NP-153)', () => {
  it('shows a member the roles without letting them change any', async () => {
    membersApi('u3');
    await renderNpRoutes(membersRoutes(), { url: '/config/members' });
    const row = (await screen.findByText('Mia Member')).closest('tr')!;
    await waitFor(() =>
      expect(within(row).getByText('NocoProject member')).toBeVisible(),
    );
    expect(
      screen.queryByRole('combobox', { name: 'Roles of Mia Member' }),
    ).toBeNull();
    expect(screen.queryByText('User management')).toBeNull();
  });

  it('lets an admin assign roles but not owner, and keeps platform roles out', async () => {
    const puts: unknown[] = [];
    membersApi('u2', {
      'PUT np/members/u3/roles': (options: RequestOptions) => {
        puts.push(options.json);
        return { data: {} };
      },
    });
    const user = userEvent.setup();
    await renderNpRoutes(membersRoutes(), { url: '/config/members' });
    await screen.findByText('Mia Member');
    await waitFor(() => expect(rolesOf('Mia Member')).toBeEnabled());
    await user.click(rolesOf('Mia Member'));
    expect(
      await screen.findByRole('option', { name: 'NocoProject owner' }),
    ).toHaveAttribute('aria-disabled', 'true');
    // A role with platform grants is offered only to whoever already holds it.
    expect(screen.queryByRole('option', { name: 'Ops' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Observer' }));
    await waitFor(() =>
      expect(puts).toEqual([{ roles: ['np-member', 'np-r-1'] }]),
    );
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        title: 'Roles of Mia Member updated.',
      }),
    );
  });

  it('offers the owner role only to an owner', async () => {
    membersApi('u1');
    const user = userEvent.setup();
    await renderNpRoutes(membersRoutes(), { url: '/config/members' });
    await screen.findByText('Mia Member');
    await waitFor(() => expect(rolesOf('Mia Member')).toBeEnabled());
    await user.click(rolesOf('Mia Member'));
    expect(
      await screen.findByRole('option', { name: 'NocoProject owner' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('says why the server refused a role change', async () => {
    membersApi('u1', {
      'PUT np/members/u3/roles': () =>
        Promise.reject(
          new ApiClientError('conflict', {
            status: 409,
            code: 'ROLE_HAS_PLATFORM_GRANTS',
            method: 'PUT',
            url: 'np/members/u3/roles',
            payload: null,
          }),
        ),
    });
    const user = userEvent.setup();
    await renderNpRoutes(membersRoutes(), { url: '/config/members' });
    await screen.findByText('Mia Member');
    await waitFor(() => expect(rolesOf('Mia Member')).toBeEnabled());
    await user.click(rolesOf('Mia Member'));
    await user.click(await screen.findByRole('option', { name: 'Observer' }));
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title:
            'This role holds platform permissions; assign it in the platform settings.',
        }),
      ),
    );
  });
});

describe('roles (NP-153)', () => {
  it('lists every role with its type, holders and platform grants', async () => {
    membersApi('u2');
    await renderNpRoutes(membersRoutes(), { url: '/config/members?tab=roles' });
    const table = await screen.findByRole('table');
    await within(table).findByText('Observer');
    const ops = within(table).getByText('Ops').closest('tr')!;
    expect(within(ops).getByText('Platform permissions')).toBeVisible();
    expect(within(ops).getByText('Custom')).toBeVisible();
    const member = within(table).getByText('NocoProject member').closest('tr')!;
    expect(within(member).getByText('Built-in')).toBeVisible();
    expect(within(member).getByText('3')).toBeVisible();
    expect(
      screen.getByText(/Holding "Define roles" gives access to anything/),
    ).toBeVisible();
    // Built-in roles are never deleted.
    expect(
      screen.queryByRole('button', { name: 'Delete NocoProject member' }),
    ).toBeNull();
  });

  it('deletes a custom role nobody holds after confirming, and lists the holders of one in use', async () => {
    const deleted: string[] = [];
    membersApi('u2', {
      'DELETE np/access/roles/np-r-1': () => {
        deleted.push('np-r-1');
        return undefined;
      },
    });
    const user = userEvent.setup();
    await renderNpRoutes(membersRoutes(), { url: '/config/members?tab=roles' });
    await user.click(await screen.findByRole('button', { name: 'Delete Ops' }));
    const inUse = await screen.findByRole('alertdialog');
    expect(within(inUse).getByText('Adam Admin')).toBeVisible();
    expect(
      within(inUse).getByRole('button', { name: 'Delete' }),
    ).toBeDisabled();
    await user.click(within(inUse).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Delete Observer' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toEqual(['np-r-1']));
  });

  it('creates a role and opens it', async () => {
    const created: unknown[] = [];
    membersApi('u2', {
      'POST np/access/roles': (options: RequestOptions) => {
        created.push(options.json);
        return { data: { ...ROLES[3], key: 'np-r-9', title: 'Auditor' } };
      },
    });
    const user = userEvent.setup();
    await renderNpRoutes(membersRoutes(), { url: '/config/members?tab=roles' });
    await user.click(await screen.findByRole('button', { name: 'New role' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Auditor');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(created).toEqual([{ title: 'Auditor', grants: [] }]),
    );
  });
});

describe('role editor (NP-153)', () => {
  it('groups pages, settings and business actions and saves the chosen scope', async () => {
    const saved: unknown[] = [];
    membersApi('u2', {
      'PUT np/access/roles/np-r-1': (options: RequestOptions) => {
        saved.push(options.json);
        return { data: ROLES[3] };
      },
    });
    const user = userEvent.setup();
    await renderNp(<RoleDetailPage />, {
      url: '/config/members/roles/np-r-1',
      path: '/config/members/roles/:roleKey',
    });
    expect(await screen.findByText('Pages')).toBeVisible();
    expect(screen.getByText('Settings')).toBeVisible();
    expect(screen.getByText('Business actions')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: 'Issues' }));
    await user.click(screen.getByRole('switch', { name: 'View' }));
    await user.click(
      screen.getByRole('switch', { name: 'Close (done / cancelled)' }),
    );
    const scope = screen.getByRole('combobox', {
      name: 'Data scope of Close (done / cancelled)',
    });
    expect(scope).toHaveTextContent('I own or lead (NocoProject rules)');
    await user.click(scope);
    await user.click(
      await screen.findByRole('option', { name: 'All records' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toEqual([
        {
          title: 'Observer',
          grants: [
            {
              resource: { type: 'page', id: 'np-issues' },
              actions: [{ action: 'access' }],
            },
            {
              resource: { type: 'composite', id: 'nocoproject.issues' },
              actions: [
                {
                  action: 'view',
                  policy: {
                    type: 'composite',
                    scopes: { issues: 'nocoproject.visible' },
                  },
                },
                {
                  action: 'close',
                  policy: {
                    type: 'composite',
                    scopes: { issues: 'allRecords' },
                  },
                },
              ],
            },
          ],
        },
      ]),
    );
  });

  it('shows the owner role read-only, and warns about platform grants', async () => {
    membersApi('u1');
    const first = await renderNp(<RoleDetailPage />, {
      url: '/config/members/roles/np-owner',
      path: '/config/members/roles/:roleKey',
    });
    expect(
      await screen.findByText(
        /The owner role holds every NocoProject permission/,
      ),
    ).toBeVisible();
    for (const control of screen.getAllByRole('switch'))
      expect(disabled(control)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    first.unmount();

    await renderNp(<RoleDetailPage />, {
      url: '/config/members/roles/np-r-2',
      path: '/config/members/roles/:roleKey',
    });
    expect(
      await screen.findByText(/This role also holds platform permissions/),
    ).toBeVisible();
  });

  it('shows a role read-only to someone who may not define roles', async () => {
    membersApi('u3');
    await renderNp(<RoleDetailPage />, {
      url: '/config/members/roles/np-r-1',
      path: '/config/members/roles/:roleKey',
    });
    await screen.findByText('Business actions');
    expect(disabled(screen.getByRole('checkbox', { name: 'Issues' }))).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
