/**
 * Members and their roles (docs/phase1/iteration-1-contract.md §B).
 *
 * Bootstrap: every signed-in `/np/*` request passes `ensure(userId)` first. The first user ever becomes `owner`;
 * everyone else becomes `member` on first contact. Role rules:
 *
 * - owner/admin may change roles between admin and member;
 * - only an owner may grant or revoke owner;
 * - the last owner cannot be demoted.
 */
import type { Actor } from '../shared/activity.js';
import { forbid, isAdmin, isMemberRole, viewerOf } from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import {
  bool,
  isPostgres,
  isUniqueViolation,
  knexOf,
  now,
  num,
  str,
} from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  Member,
  MemberPreferences,
  MemberRole,
} from '../shared/protocol.js';

export interface MemberService {
  /** Makes sure the signed-in user has a members row; returns the role. */
  ensure(userId: string): Promise<MemberRole>;
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

async function roleOf(conn: Conn, userId: string): Promise<MemberRole | null> {
  const row = await conn.query
    .selectFrom('members')
    .select('role')
    .where('userId', '=', userId)
    .executeTakeFirst();
  return row && isMemberRole(row.role) ? row.role : null;
}

async function ownerCount(conn: Conn): Promise<number> {
  const row = await conn.query
    .selectFrom('members')
    .select((eb) => [eb.fn.countAll().as('count')])
    .where('role', '=', 'owner')
    .executeTakeFirst();
  return num(row?.count);
}

async function describe(conn: Conn, userId: string): Promise<Member> {
  const user = await conn.query
    .selectFrom('user')
    .select(['id', 'name', 'username', 'email'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw notFound('User');
  return {
    userId,
    name: str(user.name) || str(user.username) || str(user.email) || userId,
    email: str(user.email),
    role: (await roleOf(conn, userId)) ?? 'member',
  };
}

function validateTransition(
  actorRole: MemberRole,
  from: MemberRole,
  to: MemberRole,
): void {
  if (actorRole !== 'owner' && actorRole !== 'admin')
    forbid('Only an owner or admin may change member roles.');
  if ((from === 'owner' || to === 'owner') && actorRole !== 'owner')
    forbid('Only an owner may grant or revoke the owner role.');
}

export function createMemberService(deps: {
  tx: TxRunner;
  ids: IdSource;
}): MemberService {
  // Members are never deleted, so a user seen once needs no further lookup in this process.
  const known = new Map<string, MemberRole>();

  async function ensure(userId: string): Promise<MemberRole> {
    const cached = known.get(userId);
    if (cached) return cached;
    const existing = await roleOf(deps.tx.read(), userId);
    if (existing) {
      known.set(userId, existing);
      return existing;
    }
    try {
      const role = await deps.tx.run(async (tx) => {
        // Serialize bootstrap so two first users cannot both become owner.
        if (isPostgres(tx.conn)) {
          const knex = await knexOf(tx.conn);
          await knex.raw(
            "SELECT pg_advisory_xact_lock(hashtext('np:members'))",
          );
        }
        const again = await roleOf(tx.conn, userId);
        if (again) return again;
        const anyone = await tx.conn.query
          .selectFrom('members')
          .select('id')
          .exists();
        const next: MemberRole = anyone ? 'member' : 'owner';
        await insertMember(tx, deps.ids, userId, next);
        return next;
      });
      return role;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return (await roleOf(deps.tx.read(), userId)) ?? 'member';
    }
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
      const result = await deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        if (!isAdmin(viewer))
          forbid('Only an owner or admin may change member roles.');
        if (isPostgres(tx.conn)) {
          const knex = await knexOf(tx.conn);
          await knex.raw(
            "SELECT pg_advisory_xact_lock(hashtext('np:members'))",
          );
        }
        const target = await describe(tx.conn, userId);
        const current = (await roleOf(tx.conn, userId)) ?? null;
        const from = current ?? 'member';
        validateTransition(viewer.role, from, role);
        if (from === role && current) return target;
        if (from === 'owner' && (await ownerCount(tx.conn)) <= 1)
          throw conflict('LAST_OWNER', 'The last owner cannot be demoted.');
        if (current) {
          await tx.conn.query
            .updateTable('members')
            .set({ role, updatedAt: now() })
            .where('userId', '=', userId)
            .execute();
        } else {
          await insertMember(tx, deps.ids, userId, role);
        }
        return { ...target, role };
      });
      known.set(userId, result.role);
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
