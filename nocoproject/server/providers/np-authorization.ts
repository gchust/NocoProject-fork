/**
 * NocoProject on the authorization plugin (NP-117, `server/modules/shared/access.ts`).
 *
 * - `registerNpAuthorization`: the settings items behind the `/config` tabs, listed under Administration → NocoProject in the
 *   permission workspace, and the protection of `np-owner` (code-owned assignments, editable grants, one active
 *   assignment always remains).
 * - `createActorAccess` / `npAccess`: a request's `ActorAccess` over its `AuthorizationContext`.
 * - `createBuiltinRoles`: `RoleAssignments` over the permission-set service, bound to the caller's transaction.
 * - `reconcileRoleProjection`: rewrites `members.role` from the assignments (at start and whenever assignments change,
 *   including changes made in the Users page or the permission workspace).
 *
 * The permission sets themselves are configuration, created once by the seed `2026100800002_np_role_permission_sets`;
 * nothing here creates or overwrites them.
 */
import type {
  AppAuthorization,
  AuthorizationContext,
  AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import {
  PermissionSetLastAssignmentError,
  PermissionSetNotFoundError,
  type PermissionSetsApi,
} from '@nocobase/authorization/permission-sets';
import type { DatabaseConnection } from '@nocobase/db';
import type { MiddlewareHandler } from 'hono';

import type { RoleAssignments } from '../modules/member/member.roles.js';
import {
  NP_ADMIN_SET,
  NP_MEMBER_SET,
  NP_OWNER_SET,
  NP_SETTINGS,
  NP_SETTINGS_ACTIONS,
  projectRole,
  type ActorAccess,
} from '../modules/shared/access.js';
import type { Conn } from '../modules/shared/db.js';
import {
  NP_ACCESS_VARIABLE,
  type NpAccessEnv,
} from '../modules/shared/http.js';
import { now, str } from '../modules/shared/db.js';
import { conflict } from '../modules/shared/errors.js';
import type { MemberRole } from '../modules/shared/protocol.js';

/** The application's i18n namespace (its package name). */
const NS = 'nocoproject';
const PROTECTION_OWNER = 'nocoproject';
const SECTION = 'nocoproject';

const SETTINGS_TITLES: Readonly<Record<string, string>> = {
  [NP_SETTINGS.general]: 'general',
  [NP_SETTINGS.members]: 'members',
  [NP_SETTINGS.workflows]: 'workflows',
  [NP_SETTINGS.labels]: 'labels',
  [NP_SETTINGS.github]: 'github',
};

function title(key: string): { key: string; ns: string } {
  return { key: `np.access.${key}`, ns: NS };
}

/** Registers the NocoProject settings items and protects `np-owner`; returns what releases the protection. */
export function registerNpAuthorization(authz: AppAuthorization): () => void {
  authz.ui.sections.add({
    name: SECTION,
    title: title('section'),
    parent: 'administration',
  });
  for (const [id, actions] of Object.entries(NP_SETTINGS_ACTIONS)) {
    authz.settings.add({
      id,
      title: title(`settings.${SETTINGS_TITLES[id]}`),
      actions: actions.map((name) => ({
        name,
        title: title(`actions.${name}`),
      })),
    });
    authz.ui.place({ type: 'settings', id }, { section: SECTION });
  }
  return authz.permissionSets.protect({
    owner: PROTECTION_OWNER,
    keys: [NP_OWNER_SET],
    // The permission workspace may still edit what owners hold, never who holds it.
    allow: ['update'],
    requireActiveAssignment: true,
    assignableTo: ['user'],
  });
}

function isUnrestricted(
  sets: PermissionSetsApi<DatabaseConnection>,
  keys: Iterable<string>,
): boolean {
  for (const key of keys) if (sets.protection(key)?.unrestricted) return true;
  return false;
}

async function roleOfUser(
  sets: PermissionSetsApi<DatabaseConnection>,
  userId: string,
): Promise<MemberRole> {
  // Bound to the caller's connection: inside a transaction, every read must go through it.
  const held = await sets.getEffective({
    principal: { type: 'user', id: userId },
  });
  const keys = new Set(held.map((set) => set.key));
  return projectRole(keys, isUnrestricted(sets, keys));
}

/** The request's `ActorAccess`: checks go to its authorization context, the role is read once. */
export function createActorAccess(
  authz: AppAuthorization,
  context: AuthorizationContext,
): ActorAccess {
  const { principal } = context.identity;
  let role: Promise<MemberRole> | undefined;
  return {
    role: (conn) =>
      (role ??=
        principal.type === 'user'
          ? roleOfUser(authz.permissionSets.withTransaction(conn), principal.id)
          : Promise.resolve('member')),
    can: (check) => context.can(check),
  };
}

/**
 * After `authz.middleware()`: gives the request its `ActorAccess`, which `sessionActor` puts on the actor. Every browser
 * prefix installs it (`server/routes/np-api.ts`).
 */
export function npAccess(
  authz: AppAuthorization,
): MiddlewareHandler<AuthorizationEnv & NpAccessEnv> {
  return async (context, next) => {
    context.set(
      NP_ACCESS_VARIABLE,
      createActorAccess(authz, context.get('authz')),
    );
    await next();
  };
}

async function replaceOne(
  sets: PermissionSetsApi<DatabaseConnection>,
  userId: string,
  key: string,
  held: boolean,
): Promise<void> {
  try {
    await sets.replaceSubjectAssignments({
      subject: { type: 'user', id: userId },
      managedPermissionSets: [key],
      permissionSets: held ? [key] : [],
    });
  } catch (error) {
    if (error instanceof PermissionSetLastAssignmentError)
      throw conflict('LAST_OWNER', 'The last owner cannot be demoted.');
    if (error instanceof PermissionSetNotFoundError)
      throw conflict(
        'ROLE_SET_MISSING',
        `The permission set ${key} does not exist; restore it in the permission settings.`,
      );
    throw error;
  }
}

/** `RoleAssignments` on the permission-set service; each call joins the caller's transaction. */
export function createBuiltinRoles(authz: AppAuthorization): RoleAssignments {
  const bound = (conn: Conn) => authz.permissionSets.withTransaction(conn);
  return {
    roleOf: (conn, userId) => roleOfUser(bound(conn), userId),
    async admit(conn, userId) {
      const sets = bound(conn);
      if (!(await sets.get(NP_MEMBER_SET))) return;
      const assigned = await sets.listAssignments(NP_MEMBER_SET);
      if (
        assigned.some(
          ({ subject }) => subject.type === 'user' && subject.id === userId,
        )
      )
        return;
      await sets.assign({
        permissionSet: NP_MEMBER_SET,
        subject: { type: 'user', id: userId },
      });
    },
    setOwner: (conn, userId, owner) =>
      replaceOne(bound(conn), userId, NP_OWNER_SET, owner),
    setAdmin: (conn, userId, admin) =>
      replaceOne(bound(conn), userId, NP_ADMIN_SET, admin),
    changed: (userId) =>
      authz.permissionSets.notifyAssignmentsChanged({
        type: 'user',
        id: userId,
      }),
  };
}

/** The users holding each set among `keys`, from one listing per set. */
async function holders(
  sets: PermissionSetsApi<DatabaseConnection>,
  keys: readonly string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  for (const key of keys) {
    for (const { subject } of await sets.listAssignments(key)) {
      if (subject.type !== 'user') continue;
      const held = result.get(subject.id) ?? new Set<string>();
      held.add(key);
      result.set(subject.id, held);
    }
  }
  return result;
}

/**
 * Rewrites every `members.role` that differs from the projection of the current assignments. A handful of queries
 * whatever the number of members, so it runs on every assignment change.
 */
export async function reconcileRoleProjection(
  authz: AppAuthorization,
  conn: Conn,
): Promise<void> {
  const sets = authz.permissionSets.withTransaction(conn);
  const unrestricted = (await sets.list())
    .map((set) => set.key)
    .filter((key) => sets.protection(key)?.unrestricted);
  const held = await holders(sets, [
    NP_OWNER_SET,
    NP_ADMIN_SET,
    ...unrestricted,
  ]);
  const rows = await conn.query
    .selectFrom('members')
    .select(['userId', 'role'])
    .execute();
  for (const row of rows) {
    const userId = str(row.userId) ?? '';
    const keys = held.get(userId) ?? new Set<string>();
    const role = projectRole(keys, isUnrestricted(sets, keys));
    if (row.role === role) continue;
    await conn.query
      .updateTable('members')
      .set({ role, updatedAt: now() })
      .where('userId', '=', userId)
      .execute();
  }
}
