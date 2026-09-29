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
 *
 * NP-153 stage 1: the business actions below (`NP_BUSINESS`) replace the old owner/admin bypass. Each is a composite of
 * the built-in authorization with two data scopes, NocoProject's own ("related") and `allRecords` ("all"); the
 * services read the resulting three-state `NpScope` (`shared/authz.ts` `scopeOf`) and keep implementing "related"
 * with their own SQL.
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

/**
 * `read` opens the tab; `update` changes it; `invite` (members) invites without a project and manages every invitation;
 * `assign` (members) gives and takes business roles, `define-roles` creates, edits and deletes them (registered in
 * NP-153 stage 1, used from stage 2).
 */
export type NpSettingsAction =
  'read' | 'update' | 'invite' | 'assign' | 'define-roles';

export const NP_SETTINGS_ACTIONS: Readonly<
  Record<NpSettingsId, readonly NpSettingsAction[]>
> = {
  [NP_SETTINGS.general]: ['read', 'update'],
  [NP_SETTINGS.members]: ['read', 'invite', 'assign', 'define-roles'],
  [NP_SETTINGS.workflows]: ['read', 'update'],
  [NP_SETTINGS.labels]: ['read', 'update'],
  [NP_SETTINGS.github]: ['read', 'update'],
};

/** The business composites (NP-153), registered by `server/providers/np-authorization.business.ts`. */
export const NP_BUSINESS = {
  projects: 'nocoproject.projects',
  issues: 'nocoproject.issues',
  pullRequests: 'nocoproject.pullRequests',
  agents: 'nocoproject.agents',
  knowledge: 'nocoproject.knowledge',
  skills: 'nocoproject.skills',
  intake: 'nocoproject.intake',
  reports: 'nocoproject.reports',
} as const;

export type NpBusinessId = (typeof NP_BUSINESS)[keyof typeof NP_BUSINESS];

/**
 * The actions of each composite. What "related" means for each is the service rule it replaces:
 *
 * | Action                         | related                                          | all                        |
 * | ------------------------------ | ------------------------------------------------ | -------------------------- |
 * | projects view                  | public projects and those the viewer joined      | every project              |
 * | projects create                | allowed (no scope)                               | allowed                    |
 * | projects manage                | projects the viewer leads                        | every project              |
 * | projects delete                | never (the action only offers "all")             | every project              |
 * | issues view / edit             | issues in the projects the viewer may see        | every issue                |
 * | issues close / change-owner    | issues the viewer owns or whose project they lead | every issue               |
 * | pullRequests merge             | as issues close                                  | every issue                |
 * | agents manage / env            | agents the viewer owns                           | every agent (env: also plaintext and the audit) |
 * | knowledge decide               | documents of projects the viewer leads           | every document             |
 * | skills manage                  | skills the viewer created                        | every skill                |
 * | intake manage                  | batches the viewer created                       | every batch                |
 * | reports view                   | the projects the viewer may see                  | every project              |
 *
 * `none` refuses: an invisible object is 404, a refused write 403 `FORBIDDEN`. Project manager conversations stay
 * visible only to their owner whatever the scope.
 */
export const NP_BUSINESS_ACTIONS = {
  [NP_BUSINESS.projects]: ['view', 'create', 'manage', 'delete'],
  [NP_BUSINESS.issues]: ['view', 'edit', 'close', 'change-owner'],
  [NP_BUSINESS.pullRequests]: ['merge'],
  [NP_BUSINESS.agents]: ['manage', 'env'],
  [NP_BUSINESS.knowledge]: ['decide'],
  [NP_BUSINESS.skills]: ['manage'],
  [NP_BUSINESS.intake]: ['manage'],
  [NP_BUSINESS.reports]: ['view'],
} as const satisfies Readonly<Record<NpBusinessId, readonly string[]>>;

export type NpBusinessAction<C extends NpBusinessId = NpBusinessId> =
  (typeof NP_BUSINESS_ACTIONS)[C][number];

/** `composite/action`, the key of a scope in `NpScopes`. */
export type NpBusinessKey = {
  [C in NpBusinessId]: `${C}/${NpBusinessAction<C>}`;
}[NpBusinessId];

/**
 * What a caller may do with a business action: on every record (`all`), on the records NocoProject's own rules relate
 * to them (`related`), or not at all (`none`).
 */
export type NpScope = 'all' | 'related' | 'none';

export type NpScopes = Readonly<Record<NpBusinessKey, NpScope>>;

export function businessKey<C extends NpBusinessId>(
  composite: C,
  action: NpBusinessAction<C>,
): NpBusinessKey {
  return `${composite}/${action}` as NpBusinessKey;
}

/** Every business action, in registration order. */
export const NP_BUSINESS_KEYS: readonly {
  readonly composite: NpBusinessId;
  readonly action: NpBusinessAction;
  readonly key: NpBusinessKey;
}[] = Object.entries(NP_BUSINESS_ACTIONS).flatMap(([composite, actions]) =>
  actions.map((action: string) => ({
    composite: composite as NpBusinessId,
    action: action as NpBusinessAction,
    key: `${composite}/${action}` as NpBusinessKey,
  })),
);

/** Every action at `scope`. */
export function uniformScopes(scope: NpScope): NpScopes {
  return Object.fromEntries(
    NP_BUSINESS_KEYS.map(({ key }) => [key, scope]),
  ) as unknown as NpScopes;
}

/**
 * A caller without the built-in authorization (internal actors such as the project manager's asking member, the
 * daemon): NocoProject's own rules only, never "all".
 */
export const RELATED_SCOPES: NpScopes = uniformScopes('related');

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
  /**
   * The caller's scope of every business action (`NP_BUSINESS`), decided once per request. The browser guard resolves
   * it before the handler runs (`npAccess`), so reading it inside a transaction never touches the connection.
   */
  scopes(): Promise<NpScopes>;
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
