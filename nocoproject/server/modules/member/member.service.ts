/**
 * Members and their roles (docs/phase1/iteration-1-contract.md §B; NP-117).
 *
 * Roles are the built-in permission sets `np-owner` / `np-admin` / `np-member` (`shared/access.ts`), reached through
 * `RoleAssignments`; `members.role` only projects them. Every signed-in `/np/*` request passes `ensure(userId)` first:
 * a user seen for the first time gets a members row with their projected role and the `np-member` set. Arriving first
 * no longer makes anyone owner: a new installation's owner is its initial administrator (seed
 * `2026100800002_np_role_permission_sets`). Role rules for `PATCH /np/members/:userId`:
 *
 * - only an owner may grant or revoke owner, and the last active owner cannot give it up (409 `LAST_OWNER`);
 * - admin and member are ordinary role assignments: only whoever may assign roles in the Users page (`user` `assign-role`)
 *   changes them here, as there.
 */
import type { Actor } from '../shared/activity.js';
import { forbid, isMemberRole, viewerOf } from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import {
  bool,
  isPostgres,
  isUniqueViolation,
  knexOf,
  now,
  str,
} from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  Member,
  MemberPreferences,
  MemberRole,
} from '../shared/protocol.js';
import type { RoleAssignments } from './member.roles.js';

export interface MemberService {
  /** Makes sure the signed-in user has a members row (and, the first time, the `np-member` set). */
  ensure(userId: string): Promise<void>;
  list(actor: Actor): Promise<Member[]>;
  updateRole(actor: Actor, userId: string, role: unknown): Promise<Member>;
  /** The member's own preferences (NP-108); the row exists, `ensureMember` runs before every browser route. */
  preferences(userId: string): Promise<MemberPreferences>;
  /** Changes only the fields given; anything but a boolean `inboxChime` is 400 `INVALID_PREFERENCES`. */
  updatePreferences(userId: string, input: unknown): Promise<MemberPreferences>;
}

function preferencesPatch(input: unknown): Partial<MemberPreferences> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw invalid('INVALID_PREFERENCES', 'Preferences must be an object.');
  const { inboxChime } = input as { inboxChime?: unknown };
  if (inboxChime === undefined) return {};
  if (typeof inboxChime !== 'boolean')
    throw invalid('INVALID_PREFERENCES', 'inboxChime must be a boolean.');
  return { inboxChime };
}

async function preferencesOf(
  conn: Conn,
  userId: string,
): Promise<MemberPreferences> {
  const row = await conn.query
    .selectFrom('members')
    .select('inboxChime')
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Member');
  return { inboxChime: row.inboxChime == null ? true : bool(row.inboxChime) };
}

async function insertMember(
  tx: Tx,
  ids: IdSource,
  userId: string,
  role: MemberRole,
): Promise<void> {
  const timestamp = now();
  await tx.conn.query
    .insertInto('members')
    .values({
      id: ids.next(),
      userId,
      role,
      joinedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
}

async function hasRow(conn: Conn, userId: string): Promise<boolean> {
  return conn.query
    .selectFrom('members')
    .select('id')
    .where('userId', '=', userId)
    .exists();
}

/** Serializes member bootstrap and role changes. */
async function lockMembers(conn: Conn): Promise<void> {
  if (!isPostgres(conn)) return;
  const knex = await knexOf(conn);
  await knex.raw("SELECT pg_advisory_xact_lock(hashtext('np:members'))");
}

/**
 * Makes sure `userId` has a members row: a new row projects the user's current role and admits them (`np-member`).
 * Returns whether the row was created. Runs in the caller's transaction (the invitation acceptance shares it).
 */
export async function admitMember(
  tx: Tx,
  ids: IdSource,
  roles: RoleAssignments,
  userId: string,
): Promise<boolean> {
  await lockMembers(tx.conn);
  if (await hasRow(tx.conn, userId)) return false;
  await insertMember(tx, ids, userId, await roles.roleOf(tx.conn, userId));
  await roles.admit(tx.conn, userId);
  return true;
}

/** Writes the `members.role` projection of the user's current assignments. */
async function project(
  tx: Tx,
  ids: IdSource,
  roles: RoleAssignments,
  userId: string,
): Promise<MemberRole> {
  const role = await roles.roleOf(tx.conn, userId);
  if (await hasRow(tx.conn, userId)) {
    await tx.conn.query
      .updateTable('members')
      .set({ role, updatedAt: now() })
      .where('userId', '=', userId)
      .execute();
  } else {
    await insertMember(tx, ids, userId, role);
  }
  return role;
}

interface Target extends Omit<Member, 'role'> {
  readonly disabled: boolean;
}

async function describe(conn: Conn, userId: string): Promise<Target> {
  const user = await conn.query
    .selectFrom('user')
    .select(['id', 'name', 'username', 'email', 'disabledAt', 'deletedAt'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user || user.deletedAt) throw notFound('User');
  return {
    userId,
    name: str(user.name) || str(user.username) || str(user.email) || userId,
    email: str(user.email),
    disabled: !!user.disabledAt,
  };
}

const RANK: Readonly<Record<MemberRole, number>> = {
  member: 0,
  admin: 1,
  owner: 2,
};

/**
 * Whether `actor` may change ordinary role assignments: the Users page's `user` `assign-role`. A caller without the
 * built-in authorization (an internal actor) may not.
 */
async function canAssignRoles(conn: Conn, actor: Actor): Promise<boolean> {
  await viewerOf(conn, actor);
  if (!actor.access) return false;
  return actor.access.can({
    resource: { type: 'user', id: '*' },
    action: 'assign-role',
  });
}

/** Applies `from → to` through the role store; the caller has checked who may. */
async function applyRole(
  conn: Conn,
  roles: RoleAssignments,
  userId: string,
  from: MemberRole,
  to: MemberRole,
): Promise<void> {
  if (to === 'owner') {
    await roles.setOwner(conn, userId, true);
    return;
  }
  if (from === 'owner') await roles.setOwner(conn, userId, false);
  await roles.setAdmin(conn, userId, to === 'admin');
}

export function createMemberService(deps: {
  tx: TxRunner;
  ids: IdSource;
  roles: () => RoleAssignments;
}): MemberService {
  // Members are never deleted, so a user seen once needs no further lookup in this process.
  const known = new Set<string>();

  async function ensure(userId: string): Promise<void> {
    if (known.has(userId)) return;
    if (!(await hasRow(deps.tx.read(), userId))) {
      const roles = deps.roles();
      try {
        const created = await deps.tx.run((tx) =>
          admitMember(tx, deps.ids, roles, userId),
        );
        if (created) await roles.changed(userId);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    known.add(userId);
  }

  return {
    ensure,

    async list(actor) {
      const conn = deps.tx.read();
      await viewerOf(conn, actor);
      const users = await conn.query
        .selectFrom('user')
        .select(['id', 'name', 'username', 'email'])
        .where('deletedAt', 'is', null)
        .where('disabledAt', 'is', null)
        .orderBy('name', 'asc')
        .execute();
      const rows = await conn.query
        .selectFrom('members')
        .select(['userId', 'role'])
        .execute();
      const roles = new Map(
        rows.map((row) => [str(row.userId) ?? '', str(row.role)]),
      );
      return users.map((user) => {
        const id = str(user.id) ?? '';
        const role = roles.get(id);
        return {
          userId: id,
          name: str(user.name) || str(user.username) || str(user.email) || id,
          email: str(user.email),
          role: isMemberRole(role) ? role : 'member',
        };
      });
    },

    async updateRole(actor, userId, role) {
      if (!isMemberRole(role))
        throw invalid('INVALID_ROLE', 'role must be owner, admin or member.');
      const roles = deps.roles();
      // Checked before the transaction (`ActorAccess.can`); applied only if the change needs it.
      const assigner = await canAssignRoles(deps.tx.read(), actor);
      const result = await deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        await lockMembers(tx.conn);
        const { disabled, ...target } = await describe(tx.conn, userId);
        const from = await roles.roleOf(tx.conn, userId);
        if (from === role)
          return {
            ...target,
            role: await project(tx, deps.ids, roles, userId),
          };
        if (disabled && RANK[role] > RANK[from])
          throw invalid(
            'USER_DISABLED',
            'A disabled account cannot be given a higher role.',
          );
        if (from === 'owner' || role === 'owner') {
          if (viewer.role !== 'owner')
            forbid('Only an owner may grant or revoke the owner role.');
        } else if (!assigner) {
          forbid(
            'Only someone who may assign roles in user management may change this role.',
          );
        }
        await applyRole(tx.conn, roles, userId, from, role);
        return { ...target, role: await project(tx, deps.ids, roles, userId) };
      });
      await roles.changed(userId);
      return result;
    },

    preferences(userId) {
      return preferencesOf(deps.tx.read(), userId);
    },

    async updatePreferences(userId, input) {
      const patch = preferencesPatch(input);
      return deps.tx.run(async (tx) => {
        if (Object.keys(patch).length > 0) {
          await tx.conn.query
            .updateTable('members')
            .set({ ...patch, updatedAt: now() })
            .where('userId', '=', userId)
            .execute();
        }
        return preferencesOf(tx.conn, userId);
      });
    },
  };
}
