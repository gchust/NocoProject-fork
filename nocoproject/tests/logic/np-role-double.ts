/**
 * The service tests' `RoleAssignments` (NP-117) and `ActorAccess` (NP-153): the roles live in `members.role` itself,
 * as `setRole` writes them, so the member and business rules can be tested without the authorization plugin. The
 * application uses the built-in permission sets (`server/providers/np-authorization.ts`, covered by
 * `np-access-app.test.ts` and `np-business-access-app.test.ts`).
 *
 * `roleAccess` grants what the seeds give each set (`2026100800002_np_role_permission_sets`,
 * `2026101000001_np_business_grants`): owner/admin every business action at "all" and every settings action;
 * members the everyday actions at "related" (no project deletion) and read on every tab but GitHub. `withRoleAccess`
 * gives every user actor passed to a service such an access, so the service tests exercise the same paths as a browser
 * request; `grantScopes` overrides single scopes, the way an administrator edits a role.
 */
import type { DatabaseManager } from '@nocobase/db';

import type {
  RoleAssignments,
  RoleStore,
  StoredRole,
} from '../../server/modules/member/member.roles.ts';
import {
  businessKey,
  NP_BUSINESS,
  NP_SETTINGS,
  uniformScopes,
  type AccessCheck,
  type ActorAccess,
  type NpBusinessKey,
  type NpScope,
  type NpScopes,
} from '../../server/modules/shared/access.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import type { Conn } from '../../server/modules/shared/db.ts';
import { now, num } from '../../server/modules/shared/db.ts';
import { conflict } from '../../server/modules/shared/errors.ts';
import type { MemberRole } from '../../server/modules/shared/protocol.ts';

async function roleOf(conn: Conn, userId: string): Promise<MemberRole> {
  const row = await conn.query
    .selectFrom('members')
    .select('role')
    .where('userId', '=', userId)
    .executeTakeFirst();
  const role = row?.role;
  return role === 'owner' || role === 'admin' ? role : 'member';
}

async function write(
  conn: Conn,
  userId: string,
  role: MemberRole,
): Promise<void> {
  const updated = await conn.query
    .updateTable('members')
    .set({ role, updatedAt: now() })
    .where('userId', '=', userId)
    .execute();
  if (num(updated.updatedCount) > 0) return;
  await conn.query
    .insertInto('members')
    .values({
      id: `m-${userId}`,
      userId,
      role,
      joinedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    })
    .execute();
}

export const membersTableRoles: RoleAssignments = {
  roleOf,
  admit: async () => undefined,
  async setOwner(conn, userId, owner) {
    const current = await roleOf(conn, userId);
    if (owner) return write(conn, userId, 'owner');
    if (current !== 'owner') return;
    const owners = await conn.query
      .selectFrom('members')
      .select((eb) => [eb.fn.countAll().as('count')])
      .where('role', '=', 'owner')
      .executeTakeFirst();
    if (num(owners?.count) <= 1)
      throw conflict('LAST_OWNER', 'The last owner cannot be demoted.');
    await write(conn, userId, 'member');
  },
  async setAdmin(conn, userId, admin) {
    if ((await roleOf(conn, userId)) === 'owner') return;
    await write(conn, userId, admin ? 'admin' : 'member');
  },
  changed: async () => undefined,
  async holders(conn) {
    const rows = await conn.query
      .selectFrom('members')
      .select('userId')
      .where('role', 'in', ['owner', 'admin'])
      .execute();
    return rows.map((row) => String(row.userId));
  },
};

const ROLE_KEYS: Readonly<Record<MemberRole, readonly string[]>> = {
  owner: ['np-member', 'np-owner'],
  admin: ['np-member', 'np-admin'],
  member: ['np-member'],
};

const BUILT_IN_SETS: readonly StoredRole[] = [
  { key: 'np-owner', grants: [] },
  { key: 'np-admin', grants: [] },
  { key: 'np-member', grants: [] },
];

/**
 * The service tests' `RoleStore` (NP-153 stage 2): the three built-in sets, held as `members.role` says (owner and
 * admin also hold np-member), so the legacy `PATCH /np/members/:userId` rules run on the same double as
 * `membersTableRoles`. Custom roles and the catalog are covered by `np-business-roles-app.test.ts` on the real plugin.
 */
export const membersTableRoleStore: RoleStore = {
  catalog: () => ({ pages: [], settings: [], business: [], recordAccess: [] }),
  list: async () => BUILT_IN_SETS,
  async assignments(conn) {
    const rows = await conn.query
      .selectFrom('members')
      .select(['userId', 'role'])
      .execute();
    return rows.flatMap((row) => {
      const role =
        row.role === 'owner' || row.role === 'admin' ? row.role : 'member';
      return ROLE_KEYS[role].map((permissionSet) => ({
        subject: { type: 'user', id: String(row.userId) },
        permissionSet,
      }));
    });
  },
  create: async () => {
    throw new Error('Custom roles need the authorization plugin.');
  },
  update: async () => {
    throw new Error('Custom roles need the authorization plugin.');
  },
  delete: async () => {
    throw new Error('Custom roles need the authorization plugin.');
  },
  async replace(conn, userId, _managed, keys) {
    const role: MemberRole = keys.includes('np-owner')
      ? 'owner'
      : keys.includes('np-admin')
        ? 'admin'
        : 'member';
    if (role !== 'owner') await membersTableRoles.setOwner(conn, userId, false);
    await write(conn, userId, role);
  },
};

/** np-member's business scopes: everything "related" except project deletion, which only offers "all". */
export const MEMBER_SCOPES: NpScopes = {
  ...uniformScopes('related'),
  [businessKey(NP_BUSINESS.projects, 'delete')]: 'none',
};

const ADMIN_SCOPES: NpScopes = uniformScopes('all');

/** Per-user scope overrides (`grantScopes`), keyed by user id; cleared with `resetScopes`. */
const overrides = new Map<string, Partial<Record<NpBusinessKey, NpScope>>>();

/** Overrides some of a user's business scopes until `resetScopes`, like a role an administrator edited. */
export function grantScopes(
  userId: string,
  scopes: Partial<Record<NpBusinessKey, NpScope>>,
): void {
  overrides.set(userId, { ...overrides.get(userId), ...scopes });
}

export function resetScopes(): void {
  overrides.clear();
}

function settingsAllowed(role: string, check: AccessCheck): boolean {
  if (role === 'owner' || role === 'admin') return true;
  return check.action === 'read' && check.resource.id !== NP_SETTINGS.github;
}

/** The `ActorAccess` of `userId` from their `members.role`, read at every call (tests change roles mid-way). */
export function roleAccess(
  database: DatabaseManager,
  userId: string,
): ActorAccess {
  const current = () => roleOf(database.connection(), userId);
  return {
    role: (conn) => roleOf(conn, userId),
    async can(check) {
      const role = await current();
      if (check.resource.type === 'settings')
        return settingsAllowed(role, check);
      if (check.resource.type === 'user')
        return role === 'owner' || role === 'admin';
      return false;
    },
    async scopes() {
      const role = await current();
      return {
        ...(role === 'member' ? MEMBER_SCOPES : ADMIN_SCOPES),
        ...overrides.get(userId),
      };
    },
  };
}

function isBareUser(value: unknown): value is Actor & { id: string } {
  if (!value || typeof value !== 'object') return false;
  const actor = value as Partial<Actor>;
  return actor.type === 'user' && typeof actor.id === 'string' && !actor.access;
}

/**
 * A copy of `actor` carrying `roleAccess`. The access is not enumerable, so assertions comparing actors (and events
 * that carry them) keep seeing `{ type, id }`.
 */
export function withAccess<A>(database: DatabaseManager, actor: A): A {
  if (!isBareUser(actor)) return actor;
  const copy = { ...actor };
  Object.defineProperty(copy, 'access', {
    value: roleAccess(database, actor.id),
    enumerable: false,
  });
  return copy as A;
}

/**
 * Wraps every service so a plain user actor passed as the first argument (the services' convention) gets its
 * `roleAccess`, as the browser guard gives every request one.
 */
export function withRoleAccess<S extends object>(
  database: DatabaseManager,
  services: S,
): S {
  const wrapService = (service: object) =>
    new Proxy(service, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          (value as (...input: unknown[]) => unknown).apply(
            target,
            args.length > 0
              ? [withAccess(database, args[0]), ...args.slice(1)]
              : args,
          );
      },
    });
  return new Proxy(services, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      return value && typeof value === 'object' ? wrapService(value) : value;
    },
  });
}
