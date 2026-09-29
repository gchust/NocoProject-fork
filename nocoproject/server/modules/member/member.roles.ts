/**
 * Where member roles are stored (NP-117): the built-in permission sets `np-owner`, `np-admin` and `np-member`
 * (`shared/access.ts`). The provider implements this on the authorization plugin (`server/providers/np-authorization.ts`);
 * the service tests pass a double over `members.role`.
 *
 * Every method takes the caller's transaction connection, so a role change commits or rolls back with the members row
 * that projects it; `changed` announces it after commit.
 */
import type { AccessHolders } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import type { MemberRole } from '../shared/protocol.js';

export interface RoleAssignments extends AccessHolders {
  /** The user's role, projected from what they hold (`projectRole`). */
  roleOf(conn: Conn, userId: string): Promise<MemberRole>;
  /** Gives a user who just became a member the `np-member` set, once. */
  admit(conn: Conn, userId: string): Promise<void>;
  /** Grants or revokes `np-owner`; revoking the last active owner is 409 `LAST_OWNER`. */
  setOwner(conn: Conn, userId: string, owner: boolean): Promise<void>;
  /** Grants or revokes `np-admin`, leaving every other assignment alone. */
  setAdmin(conn: Conn, userId: string, admin: boolean): Promise<void>;
  /** After commit: tells sessions and caches that the user's assignments changed. */
  changed(userId: string): Promise<void>;
}
