/**
 * NocoProject on the built-in authorization (NP-117, ADR-0006 in nocosolution/NocoProject/docs/adr).
 *
 * Who holds which NocoProject role and settings capability is stored by the authorization plugin: the permission sets
 * below, assigned to users, edited in its workspace and in the Users page. This file is the plugin-free side the
 * services use; `server/providers/np-authorization.ts` implements it on the plugin.
 *
 * - `np-owner`: the business owner identity. Protected by code: the generic management surface may edit its grants
 *   but never assign, revoke or delete it; at least one active assignment always remains. Changed only through
 *   `PATCH /np/members/:userId` by an owner.
 * - `np-admin`: business administrators. An ordinary set: assigned in the Users page by whoever may assign roles there.
 * - `np-member`: ordinary members, assigned once when a user first becomes a member.
 *
 * `members.role` is kept as a projection of these assignments (owner, else admin, else member) for lists and for
 * rollback; a request that carries `Actor.access` never reads it.
 */
import type { Conn } from './db.js';
import type { MemberRole } from './protocol.js';

export const NP_OWNER_SET = 'np-owner';
export const NP_ADMIN_SET = 'np-admin';
export const NP_MEMBER_SET = 'np-member';

/** The settings items behind the `/config` tabs, each checked on its own endpoints. */
export const NP_SETTINGS = {
  general: 'nocoproject.general',
  members: 'nocoproject.members',
  workflows: 'nocoproject.workflows',
  labels: 'nocoproject.labels',
  github: 'nocoproject.github',
} as const;

export type NpSettingsId = (typeof NP_SETTINGS)[keyof typeof NP_SETTINGS];

/** `read` opens the tab; `update` changes it; `invite` (members) invites without a project and manages every invitation. */
export type NpSettingsAction = 'read' | 'update' | 'invite';

export const NP_SETTINGS_ACTIONS: Readonly<
  Record<NpSettingsId, readonly NpSettingsAction[]>
> = {
  [NP_SETTINGS.general]: ['read', 'update'],
  [NP_SETTINGS.members]: ['read', 'invite'],
  [NP_SETTINGS.workflows]: ['read', 'update'],
  [NP_SETTINGS.labels]: ['read', 'update'],
  [NP_SETTINGS.github]: ['read', 'update'],
};

export interface AccessCheck {
  readonly resource: { readonly type: string; readonly id: string };
  readonly action: string;
}

/**
 * The built-in authorization of one signed-in user for one request (or one internal operation). Created per request;
 * never kept across requests or identities.
 */
export interface ActorAccess {
  /**
   * The NocoProject role projected from the user's permission sets; unrestricted (root) counts as admin. Read through
   * `conn` (the caller's transaction, if any) the first time, then remembered for the request.
   */
  role(conn: Conn): Promise<MemberRole>;
  /**
   * True only when the decision is an unconditional permit. Reads through the application's own connection, so call it
   * before opening a transaction (on SQLite a check inside one would wait for the connection the transaction holds).
   */
  can(check: AccessCheck): Promise<boolean>;
}

/** The role a set of held permission-set keys projects to. */
export function projectRole(
  keys: ReadonlySet<string>,
  unrestricted: boolean,
): MemberRole {
  if (keys.has(NP_OWNER_SET)) return 'owner';
  if (unrestricted || keys.has(NP_ADMIN_SET)) return 'admin';
  return 'member';
}
