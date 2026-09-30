/**
 * Where member roles are stored (NP-117): the built-in permission sets `np-owner`, `np-admin` and `np-member`
 * (`shared/access.ts`). The provider implements this on the authorization plugin (`server/providers/np-authorization.ts`);
 * the service tests pass a double over `members.role`.
 *
 * Every method takes the caller's transaction connection, so a role change commits or rolls back with the members row
 * that projects it; `changed` announces it after commit.
 */
import type { ActorAccess } from '../shared/access.js';
import type { AccessHolders } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import type {
  AccessCatalog,
  AccessGrant,
  AccessTitle,
  MemberRole,
} from '../shared/protocol.js';

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
  /**
   * NP-183: the member's own access as a browser request of theirs would carry it (role and business scopes, the
   * scopes already resolved), for the project manager acting in their name. Call it before opening a transaction: it
   * reads through the application's own connection. Absent = no such access can be built (409 on use).
   */
  accessOf?(userId: string): Promise<ActorAccess>;
}

/** A permission set as `/config` reads and writes it (NP-153 stage 2). */
export interface StoredRole {
  readonly key: string;
  readonly title?: AccessTitle;
  readonly grants: readonly AccessGrant[];
}

/** One assignment: a subject (a user, or a team or an audience assigned in the permission workspace) holds a set. */
export interface StoredAssignment {
  readonly subject: { readonly type: string; readonly id: string };
  readonly permissionSet: string;
}

/**
 * The permission sets and assignments behind the business roles (`roles.service.ts`). The provider implements it on
 * the permission-set service (`server/providers/np-authorization.roles.ts`); nothing here checks who may: the service
 * does, before it calls in.
 *
 * - `create` / `update` / `delete` run on their own (they write nothing of NocoProject's) and announce the change to
 *   every holder themselves.
 * - `replace` joins the caller's transaction; `RoleAssignments.changed` announces it after commit. Removing the last
 *   active `np-owner` is 409 `LAST_OWNER`.
 */
export interface RoleStore {
  /** Everything a business role may hold; built from NocoProject's own registrations. */
  catalog(): AccessCatalog;
  list(conn: Conn): Promise<readonly StoredRole[]>;
  assignments(conn: Conn): Promise<readonly StoredAssignment[]>;
  create(role: StoredRole): Promise<StoredRole>;
  update(key: string, role: StoredRole): Promise<StoredRole>;
  delete(key: string): Promise<void>;
  /** Makes the user's direct assignments among `managed` exactly `keys`; every other assignment stays. */
  replace(
    conn: Conn,
    userId: string,
    managed: readonly string[],
    keys: readonly string[],
  ): Promise<void>;
}
