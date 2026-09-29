/**
 * The service tests' `RoleAssignments` (NP-117): the roles live in `members.role` itself, as `setRole` writes them, so
 * the member rules can be tested without the authorization plugin. The application uses the built-in permission sets
 * (`server/providers/np-authorization.ts`, covered by `np-access-app.test.ts`).
 */
import type { RoleAssignments } from '../../server/modules/member/member.roles.ts';
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
};
