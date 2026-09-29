/**
 * `useCan` for the component tests (NP-117), answering like the seeded permission sets would: `np-member` reads the
 * `/config` tabs but GitHub, `np-admin` / `np-owner` read and change them all. `assignRoles` and `usersPage` stand for
 * the Users page's `user` `assign-role` and `page:users` `access`, which only platform administrators hold by default.
 *
 * Use with `vi.mock('@nocobase/app-plugin-authorization/client', () => import('./np-authz-double.js'))` and set the
 * viewer with `authzDouble.as(...)` before rendering.
 */
type Role = 'owner' | 'admin' | 'member';

interface Check {
  readonly resource: { readonly type: string; readonly id: string };
  readonly action: string;
}

const state: {
  role: Role;
  assignRoles: boolean;
  usersPage: boolean;
} = { role: 'member', assignRoles: false, usersPage: false };

export const authzDouble = {
  as(
    role: Role,
    options: { assignRoles?: boolean; usersPage?: boolean } = {},
  ): void {
    state.role = role;
    state.assignRoles = options.assignRoles ?? false;
    state.usersPage = options.usersPage ?? false;
  },
};

function allowed(check: Check): boolean {
  const { type, id } = check.resource;
  if (type === 'user')
    return check.action === 'assign-role' && state.assignRoles;
  if (type === 'page') return id === 'users' ? state.usersPage : true;
  if (type !== 'settings' || !id.startsWith('nocoproject.')) return false;
  if (state.role !== 'member') return true;
  return check.action === 'read' && id !== 'nocoproject.github';
}

// eslint-disable-next-line @eslint-react/no-unnecessary-use-prefix -- replaces the plugin's hook of the same name
export function useCan(check: Check): {
  readonly can: boolean;
  readonly isPending: boolean;
  readonly error: null;
  readonly retry: () => Promise<void>;
} {
  return {
    can: allowed(check),
    isPending: false,
    error: null,
    retry: async () => undefined,
  };
}
