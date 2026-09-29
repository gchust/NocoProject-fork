/**
 * Business roles in `/config/members` (NP-153 stage 2, docs/phase2/protocol-business-roles.md).
 *
 * A business role is a built-in permission set whose key starts with `np-` (`shared/access.ts` `NP_ROLE_PREFIX`); an
 * assignment is a built-in assignment. There is no other copy: the permission workspace shows the same rows. Guards,
 * each checked before any transaction opens (the authorization context reads through the application's own
 * connection):
 *
 * 1. Only `np-` sets: any other key (`root`, `member`, plugin sets) is 403 `NOT_NP_ROLE`. A replacement manages only
 *    the `np-` sets, so the user's platform assignments stay as they are.
 * 2. A role holds only what the catalog offers: 400 `GRANT_NOT_ALLOWED` (`roles.grants.ts`).
 * 3. An `np-` set that also holds platform grants (added in the permission workspace) keeps them when edited here, and
 *    cannot be assigned or revoked here: 409 `ROLE_HAS_PLATFORM_GRANTS`.
 * 4. `np-owner`: only an owner grants or revokes it, the last active owner stays (409 `LAST_OWNER`), its grants are not
 *    edited here (403 `ROLE_NOT_EDITABLE`); no built-in role is deleted (403 `ROLE_BUILT_IN`).
 * 5. Who may is read from NocoProject's settings item only: `nocoproject.members` `read` (catalog, roles), `assign`,
 *    `define-roles`. The Users page's `user` `assign-role` plays no part.
 * 6. A role someone still holds is not deleted: 409 `ROLE_IN_USE`, with the holders.
 */
import type { Actor } from '../shared/activity.js';
import {
  NP_ADMIN_SET,
  NP_BUILT_IN_ROLES,
  NP_CUSTOM_ROLE_PREFIX,
  NP_OWNER_SET,
  NP_SETTINGS,
  isNpRoleKey,
  type NpSettingsAction,
} from '../shared/access.js';
import { isMemberRole, requireSetting, viewerOf } from '../shared/authz.js';
import type { TxRunner } from '../shared/db.js';
import {
  conflict,
  forbidden,
  invalid,
  NpError,
  notFound,
} from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AccessCatalog,
  BusinessRole,
  Member,
  MemberWithRoles,
} from '../shared/protocol.js';
import type {
  RoleAssignments,
  RoleStore,
  StoredAssignment,
  StoredRole,
} from './member.roles.js';
import { describeUser, lockMembers, projectRoleOf } from './member.service.js';
import { checkGrants, splitGrants } from './roles.grants.js';

export interface RoleService {
  catalog(actor: Actor): Promise<AccessCatalog>;
  list(actor: Actor): Promise<BusinessRole[]>;
  create(actor: Actor, input: unknown): Promise<BusinessRole>;
  update(actor: Actor, key: string, input: unknown): Promise<BusinessRole>;
  remove(actor: Actor, key: string): Promise<void>;
  /** `PUT /np/members/:userId/roles`: the user's business roles become exactly `input.roles`. */
  assign(
    actor: Actor,
    userId: string,
    input: unknown,
  ): Promise<MemberWithRoles>;
  /** `PATCH /np/members/:userId { role }`, kept for older clients: owner / admin / member as an `assign`. */
  setRole(actor: Actor, userId: string, role: unknown): Promise<Member>;
}

const MAX_TITLE = 100;

function notNpRole(key: string): never {
  throw forbidden(
    'NOT_NP_ROLE',
    `${key} is not a NocoProject role; platform permission sets are managed in the platform settings.`,
  );
}

function requireNpRole(key: string): void {
  if (!isNpRoleKey(key)) notNpRole(key);
}

function titleOf(input: unknown, required: boolean): string | undefined {
  if (input === undefined && !required) return undefined;
  if (
    typeof input !== 'string' ||
    !input.trim() ||
    input.trim().length > MAX_TITLE
  )
    throw invalid(
      'INVALID_TITLE',
      `title must be 1 to ${MAX_TITLE} characters.`,
    );
  return input.trim();
}

function bodyOf(input: unknown): { title?: unknown; grants?: unknown } {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw invalid('INVALID_ROLE', 'The body must be { title, grants }.');
  return input;
}

function rolesOf(input: unknown): string[] {
  const roles = (input as { roles?: unknown } | null)?.roles;
  if (!Array.isArray(roles) || roles.some((key) => typeof key !== 'string'))
    throw invalid('INVALID_ROLES', 'roles must be a list of role keys.');
  return [...new Set<string>(roles)];
}

/** Direct user holders of each set. */
function userHolders(
  assignments: readonly StoredAssignment[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const { subject, permissionSet } of assignments) {
    if (subject.type !== 'user') continue;
    result.set(permissionSet, [
      ...(result.get(permissionSet) ?? []),
      subject.id,
    ]);
  }
  return result;
}

function describeRole(
  role: StoredRole,
  holderIds: readonly string[],
): BusinessRole {
  const { np, foreign } = splitGrants(role.grants);
  return {
    key: role.key,
    title: role.title ?? null,
    builtIn: NP_BUILT_IN_ROLES.includes(role.key),
    editable: role.key !== NP_OWNER_SET,
    hasForeignGrants: foreign.length > 0,
    grants: np,
    holderIds,
    holderCount: holderIds.length,
  };
}

/** The user's direct `np-` assignments. */
function heldBy(
  assignments: readonly StoredAssignment[],
  userId: string,
): string[] {
  return assignments
    .filter(
      ({ subject, permissionSet }) =>
        subject.type === 'user' &&
        subject.id === userId &&
        isNpRoleKey(permissionSet),
    )
    .map(({ permissionSet }) => permissionSet);
}

/**
 * The guards of a role change on data alone, so the same check runs before the transaction and again inside it on
 * what the transaction reads.
 */
function checkChange(
  sets: readonly StoredRole[],
  current: readonly string[],
  requested: readonly string[],
  operatorIsOwner: boolean,
): void {
  const byKey = new Map(sets.map((set) => [set.key, set]));
  for (const key of requested)
    if (!byKey.has(key))
      throw invalid('UNKNOWN_ROLE', `There is no role ${key}.`);
  const changed = [
    ...requested.filter((key) => !current.includes(key)),
    ...current.filter((key) => !requested.includes(key)),
  ];
  for (const key of changed) {
    const set = byKey.get(key);
    if (set && splitGrants(set.grants).foreign.length > 0)
      throw conflict(
        'ROLE_HAS_PLATFORM_GRANTS',
        `${key} also holds platform permissions; assign it in the platform settings.`,
      );
    if (key === NP_OWNER_SET && !operatorIsOwner)
      throw forbidden(
        'FORBIDDEN',
        'Only an owner may grant or revoke the owner role.',
      );
  }
}

/** The legacy role as a business-role set: owner adds np-owner, admin swaps it for np-admin, member drops both. */
function legacyRoles(current: readonly string[], role: string): string[] {
  const kept = current.filter((key) => key !== NP_OWNER_SET);
  if (role === 'owner') return [...new Set([...current, NP_OWNER_SET])];
  if (role === 'admin') return [...new Set([...kept, NP_ADMIN_SET])];
  return kept.filter((key) => key !== NP_ADMIN_SET);
}

export function createRoleService(deps: {
  tx: TxRunner;
  ids: IdSource;
  roles: () => RoleAssignments;
  store: () => RoleStore;
}): RoleService {
  const store = () => deps.store();

  async function require(
    actor: Actor,
    action: NpSettingsAction,
    message: string,
  ) {
    await requireSetting(
      deps.tx.read(),
      actor,
      NP_SETTINGS.members,
      action,
      message,
    );
  }

  async function roleView(key: string): Promise<BusinessRole> {
    const conn = deps.tx.read();
    const role = (await store().list(conn)).find((set) => set.key === key);
    if (!role) throw notFound('Role');
    return describeRole(
      role,
      userHolders(await store().assignments(conn)).get(key) ?? [],
    );
  }

  async function replaceRoles(
    actor: Actor,
    userId: string,
    requestedOf: (current: readonly string[]) => string[],
  ): Promise<MemberWithRoles> {
    const read = deps.tx.read();
    await require(actor, 'assign', 'Only someone who may assign roles in the member settings may do this.');
    const operatorIsOwner = (await viewerOf(read, actor)).role === 'owner';
    const before = heldBy(await store().assignments(read), userId);
    const requested = requestedOf(before);
    requested.forEach(requireNpRole);
    checkChange(await store().list(read), before, requested, operatorIsOwner);
    const roles = deps.roles();
    const result = await deps.tx.run(async (tx) => {
      await lockMembers(tx.conn);
      const { disabled, ...target } = await describeUser(tx.conn, userId);
      const sets = (await store().list(tx.conn)).filter((set) =>
        isNpRoleKey(set.key),
      );
      const current = heldBy(await store().assignments(tx.conn), userId);
      checkChange(sets, current, requested, operatorIsOwner);
      if (disabled && requested.some((key) => !current.includes(key)))
        throw invalid(
          'USER_DISABLED',
          'A disabled account cannot be given a role.',
        );
      await store().replace(
        tx.conn,
        userId,
        sets.map((set) => set.key),
        requested,
      );
      const role = await projectRoleOf(tx, deps.ids, roles, userId);
      return {
        ...target,
        role,
        roles: heldBy(await store().assignments(tx.conn), userId),
      };
    });
    await roles.changed(userId);
    return result;
  }

  return {
    async catalog(actor) {
      await require(actor, 'read', 'You may not read the member settings.');
      return store().catalog();
    },

    async list(actor) {
      await require(actor, 'read', 'You may not read the member settings.');
      const conn = deps.tx.read();
      const holders = userHolders(await store().assignments(conn));
      return (await store().list(conn))
        .filter((set) => isNpRoleKey(set.key))
        .map((set) => describeRole(set, holders.get(set.key) ?? []));
    },

    async create(actor, input) {
      await require(actor, 'define-roles', 'Only someone who may define roles may do this.');
      const body = bodyOf(input);
      const title = titleOf(body.title, true)!;
      const grants = checkGrants(store().catalog(), body.grants);
      const key = `${NP_CUSTOM_ROLE_PREFIX}${deps.ids.next()}`;
      await store().create({ key, title, grants });
      return roleView(key);
    },

    async update(actor, key, input) {
      requireNpRole(key);
      await require(actor, 'define-roles', 'Only someone who may define roles may do this.');
      if (key === NP_OWNER_SET)
        throw forbidden(
          'ROLE_NOT_EDITABLE',
          'The owner role holds everything; its grants are not edited here.',
        );
      const body = bodyOf(input);
      const title = titleOf(body.title, false);
      const grants = checkGrants(store().catalog(), body.grants);
      const existing = (await store().list(deps.tx.read())).find(
        (set) => set.key === key,
      );
      if (!existing) throw notFound('Role');
      await store().update(key, {
        key,
        ...(title !== undefined
          ? { title }
          : existing.title !== undefined
            ? { title: existing.title }
            : {}),
        // Platform grants stay as the permission workspace left them.
        grants: [...splitGrants(existing.grants).foreign, ...grants],
      });
      return roleView(key);
    },

    async remove(actor, key) {
      requireNpRole(key);
      await require(actor, 'define-roles', 'Only someone who may define roles may do this.');
      if (NP_BUILT_IN_ROLES.includes(key))
        throw forbidden('ROLE_BUILT_IN', 'Built-in roles cannot be deleted.');
      const conn = deps.tx.read();
      if (!(await store().list(conn)).some((set) => set.key === key))
        throw notFound('Role');
      const assigned = (await store().assignments(conn)).filter(
        (item) => item.permissionSet === key,
      );
      if (assigned.length > 0)
        throw new NpError(
          'conflict',
          'ROLE_IN_USE',
          'Someone still holds this role; change their roles first.',
          {
            holderIds: assigned
              .filter((item) => item.subject.type === 'user')
              .map((item) => item.subject.id),
            holderCount: assigned.length,
          },
        );
      await store().delete(key);
    },

    assign(actor, userId, input) {
      const requested = rolesOf(input);
      requested.forEach(requireNpRole);
      return replaceRoles(actor, userId, () => requested);
    },

    async setRole(actor, userId, role) {
      if (!isMemberRole(role))
        throw invalid('INVALID_ROLE', 'role must be owner, admin or member.');
      const { roles: _roles, ...member } = await replaceRoles(
        actor,
        userId,
        (current) => legacyRoles(current, role),
      );
      return member;
    },
  };
}
