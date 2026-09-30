/**
 * Members and their roles (docs/phase1/iteration-1-contract.md §B; NP-117).
 *
 * Roles are the built-in permission sets `np-owner` / `np-admin` / `np-member` (`shared/access.ts`), reached through
 * `RoleAssignments`; `members.role` only projects them. Every signed-in `/np/*` request passes `ensure(userId)` first:
 * a user seen for the first time gets a members row with their projected role and the `np-member` set. Arriving first
 * no longer makes anyone owner: a new installation's owner is its initial administrator (seed
 * `2026100800002_np_role_permission_sets`). Assigning roles (`PATCH /np/members/:userId` and, since NP-153,
 * `PUT /np/members/:userId/roles`) is `roles.service.ts`.
 */
import type { Actor } from '../shared/activity.js';
import { isMemberRole, viewerOf } from '../shared/authz.js';
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
  MemberPreferencesV5,
  MemberRole,
} from '../shared/protocol.js';
import type { RoleAssignments } from './member.roles.js';

export interface MemberService {
  /** Makes sure the signed-in user has a members row (and, the first time, the `np-member` set). */
  ensure(userId: string): Promise<void>;
  list(actor: Actor): Promise<Member[]>;
  /** The member's own preferences (NP-108); the row exists, `ensureMember` runs before every browser route. */
  preferences(userId: string): Promise<MemberPreferencesV5>;
  /** Changes only the fields given (`preferencesPatch`); anything malformed is 400 `INVALID_PREFERENCES`. */
  updatePreferences(
    userId: string,
    input: unknown,
  ): Promise<MemberPreferencesV5>;
}

interface PreferencesPatch {
  readonly inboxChime?: boolean;
  readonly pmConfirmAll?: boolean;
  readonly revision?: number;
}

/**
 * NP-108 `inboxChime`, NP-183 `pmConfirmAll` ("always confirm first"). `revision` is required with `pmConfirmAll` and
 * checked whenever it is given (409 `REVISION_CONFLICT`); a bare `inboxChime` change keeps working without it.
 */
function preferencesPatch(input: unknown): PreferencesPatch {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw invalid('INVALID_PREFERENCES', 'Preferences must be an object.');
  const { inboxChime, pmConfirmAll, revision } = input as Record<
    string,
    unknown
  >;
  if (inboxChime !== undefined && typeof inboxChime !== 'boolean')
    throw invalid('INVALID_PREFERENCES', 'inboxChime must be a boolean.');
  if (pmConfirmAll !== undefined && typeof pmConfirmAll !== 'boolean')
    throw invalid('INVALID_PREFERENCES', 'pmConfirmAll must be a boolean.');
  if (revision !== undefined && !Number.isInteger(revision))
    throw invalid('INVALID_PREFERENCES', 'revision must be an integer.');
  if (pmConfirmAll !== undefined && revision === undefined)
    throw invalid('REVISION_REQUIRED', 'revision is required.');
  return {
    ...(inboxChime === undefined ? {} : { inboxChime }),
    ...(pmConfirmAll === undefined ? {} : { pmConfirmAll }),
    ...(revision === undefined ? {} : { revision: revision as number }),
  };
}

export async function preferencesOf(
  conn: Conn,
  userId: string,
): Promise<MemberPreferencesV5> {
  const row = await conn.query
    .selectFrom('members')
    .select([
      'inboxChime',
      'pmConfirmAll',
      'pmAgentMode',
      'pmAgentId',
      'preferencesRevision',
    ])
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Member');
  return {
    inboxChime: row.inboxChime == null ? true : bool(row.inboxChime),
    pmConfirmAll: bool(row.pmConfirmAll),
    pmAgentMode: row.pmAgentMode === 'personal' ? 'personal' : 'system',
    pmAgentId: str(row.pmAgentId),
    revision: num(row.preferencesRevision, 1),
  };
}

/** Writes `set` when `revision` (if given) is current, bumping it; 409 `REVISION_CONFLICT` otherwise. */
export async function writePreferences(
  conn: Conn,
  userId: string,
  revision: number | undefined,
  set: Readonly<Record<string, unknown>>,
): Promise<void> {
  const current = await preferencesOf(conn, userId);
  if (revision !== undefined && revision !== current.revision)
    throw conflict('REVISION_CONFLICT', 'Preferences changed; reload them.');
  await conn.query
    .updateTable('members')
    .set({
      ...set,
      preferencesRevision: current.revision + 1,
      updatedAt: now(),
    })
    .where('userId', '=', userId)
    .where('preferencesRevision', '=', current.revision)
    .execute();
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
export async function lockMembers(conn: Conn): Promise<void> {
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
export async function projectRoleOf(
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

export interface Target extends Omit<Member, 'role'> {
  readonly disabled: boolean;
}

/** The user a role change is about; 404 for an unknown or deleted account. */
export async function describeUser(
  conn: Conn,
  userId: string,
): Promise<Target> {
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

    preferences(userId) {
      return preferencesOf(deps.tx.read(), userId);
    },

    async updatePreferences(userId, input) {
      const { revision, ...patch } = preferencesPatch(input);
      return deps.tx.run(async (tx) => {
        if (Object.keys(patch).length > 0)
          await writePreferences(tx.conn, userId, revision, patch);
        return preferencesOf(tx.conn, userId);
      });
    },
  };
}
