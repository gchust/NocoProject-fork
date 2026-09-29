/**
 * The business scopes of `shared/authz.ts` (NP-153): reading a caller's scope of a business action (`access.ts`
 * `NP_BUSINESS`) and finding who holds one on every record. Split out of `authz.ts`, which re-exports it.
 */
import {
  businessKey,
  NP_BUSINESS,
  type AccessCheck,
  type NpBusinessAction,
  type NpBusinessId,
  type NpScope,
  type NpScopes,
} from './access.js';
import type { Actor } from './activity.js';
import type { Conn } from './db.js';
import { str, unique } from './db.js';
import { forbidden } from './errors.js';

/** What the business rules read of a viewer (`authz.ts` `Viewer`). */
export interface ScopedViewer {
  readonly scopes: NpScopes;
}

/** The viewer's scope of a business action. */
export function scopeIn<C extends NpBusinessId>(
  viewer: ScopedViewer,
  composite: C,
  action: NpBusinessAction<C>,
): NpScope {
  return viewer.scopes[businessKey(composite, action)];
}

/**
 * The actor's scope of a business action (NP-153): `all` when the built-in authorization permits it on every record,
 * `related` when NocoProject's own rules decide which records, `none` when it is refused. An actor without
 * `Actor.access` (daemon, run tokens, internal actors) is `related`, never `all`. Resolved before any transaction
 * (`ActorAccess.scopes`), so it is safe to call inside one.
 */
export async function scopeOf<C extends NpBusinessId>(
  actor: Actor,
  composite: C,
  action: NpBusinessAction<C>,
): Promise<NpScope> {
  if (actor.type !== 'user' || !actor.id || !actor.access) return 'related';
  return (await actor.access.scopes())[businessKey(composite, action)];
}

/** A scope applied to a record someone owns or created: `all`, or `related` and the viewer is that person. */
export function allowsOwn(
  scope: NpScope,
  ownerId: string | null | undefined,
  userId: string,
): boolean {
  return scope === 'all' || (scope === 'related' && ownerId === userId);
}

/** 403 `FORBIDDEN` when the viewer's scope of a write action is `none`. */
export function requireAction<C extends NpBusinessId>(
  viewer: ScopedViewer,
  composite: C,
  action: NpBusinessAction<C>,
  message: string,
): void {
  if (scopeIn(viewer, composite, action) === 'none')
    throw forbidden('FORBIDDEN', message);
}

/**
 * Who holds an action on every record: a settings action, or a business composite action whose data scopes are all
 * "all" (`allRecords`). Unrestricted (root) holders count. The provider answers it from the permission sets and their
 * assignments (`server/providers/np-authorization.ts`); the service tests from `members.role`.
 */
export interface AccessHolders {
  holders(conn: Conn, check: AccessCheck): Promise<string[]>;
}

/**
 * The deciders for an action (NP-153): the members holding it on every record, replacing "every owner/admin member".
 * Only members are returned, so a platform account that never entered NocoProject gets no inbox card.
 */
export async function deciderUserIds(
  conn: Conn,
  directory: AccessHolders,
  check: AccessCheck,
): Promise<string[]> {
  const holders = await directory.holders(conn, check);
  if (holders.length === 0) return [];
  const rows = await conn.query
    .selectFrom('members')
    .select('userId')
    .where('userId', 'in', unique(holders))
    .execute();
  return unique(rows.map((row) => str(row.userId)));
}

/** The approvers behind the `admin` approver role: whoever may close every issue. */
export const ADMIN_APPROVER_CHECK: AccessCheck = {
  resource: { type: 'composite', id: NP_BUSINESS.issues },
  action: 'close',
};
