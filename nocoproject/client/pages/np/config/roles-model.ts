import type {
  AccessCatalog,
  AccessGrant,
  AccessGrantAction,
  AccessTitle,
  BusinessRole,
} from '../types-roles.js';

/**
 * Business roles in `/config/members` (NP-153): what the browser derives from `GET /np/access/{catalog,roles}` before
 * it offers a change. The server checks every rule again (`server/modules/member/roles.service.ts`); these only keep
 * the interface from offering what it will refuse.
 */

export const NP_OWNER_ROLE = 'np-owner';
export const ALL_RECORDS = 'allRecords';

/** The sidebar title of each NocoProject page a role may open (`client/routes.ts`). */
export const PAGE_TITLES: Readonly<Record<string, string>> = {
  'np-inbox': 'navigation.inbox',
  'np-my-issues': 'navigation.myIssues',
  'np-pm': 'navigation.pm',
  'np-issues': 'navigation.issues',
  'np-projects': 'navigation.projects',
  'np-agents': 'navigation.agents',
  'np-runtimes': 'navigation.runtimes',
  'np-skills': 'navigation.skills',
  'np-knowledge': 'navigation.knowledge',
  'np-reports': 'navigation.reports',
  'np-config': 'navigation.config',
};

type Translate = (key: string) => string;

/** A role's page, relative to `/config/members`. */
export function rolePath(key: string): string {
  return `roles/${encodeURIComponent(key)}`;
}

/** A title as stored: an i18n key (translated), plain text, or the fallback. */
export function accessTitle(
  t: Translate,
  title: AccessTitle | null | undefined,
  fallback: string,
): string {
  if (!title) return fallback;
  return typeof title === 'string' ? title : t(title.key);
}

export function roleTitle(t: Translate, role: BusinessRole): string {
  return accessTitle(t, role.title, role.key);
}

/** The roles `userId` holds directly, in list order. */
export function rolesOf(
  roles: readonly BusinessRole[],
  userId: string,
): string[] {
  return roles
    .filter((role) => role.holderIds.includes(userId))
    .map((role) => role.key);
}

export interface RoleOption {
  readonly value: string;
  readonly disabled: boolean;
}

/**
 * Why a role cannot be added to or removed from `userId` here, or null: a role holding platform grants is assigned in
 * the platform settings (409 `ROLE_HAS_PLATFORM_GRANTS`), only an owner grants or revokes owner, and the last owner
 * keeps it (409 `LAST_OWNER`).
 */
export function lockOf(
  role: BusinessRole,
  userId: string,
  viewerId: string | undefined,
  roles: readonly BusinessRole[],
): 'platform' | 'owner' | 'lastOwner' | null {
  if (role.hasForeignGrants) return 'platform';
  if (role.key !== NP_OWNER_ROLE) return null;
  const owner = roles.find((item) => item.key === NP_OWNER_ROLE);
  if (!viewerId || !owner?.holderIds.includes(viewerId)) return 'owner';
  if (owner.holderIds.includes(userId) && owner.holderCount <= 1)
    return 'lastOwner';
  return null;
}

/**
 * The choices of the member's role select: every role the member holds (so it shows), and every role the viewer may
 * add. Roles holding platform grants are offered only when already held, and never changeable.
 */
export function roleOptions(
  roles: readonly BusinessRole[],
  userId: string,
  viewerId: string | undefined,
): RoleOption[] {
  return roles
    .filter((role) => !role.hasForeignGrants || role.holderIds.includes(userId))
    .map((role) => ({
      value: role.key,
      disabled: lockOf(role, userId, viewerId, roles) !== null,
    }));
}

/**
 * The select's next value with the locked roles put back as they were: a locked role the member holds cannot be
 * removed, one they do not hold cannot be added.
 */
export function nextRoles(
  roles: readonly BusinessRole[],
  userId: string,
  viewerId: string | undefined,
  requested: readonly string[],
): string[] {
  const current = rolesOf(roles, userId);
  const locked = new Set(
    roles
      .filter((role) => lockOf(role, userId, viewerId, roles) !== null)
      .map((role) => role.key),
  );
  const kept = requested.filter((key) => !locked.has(key));
  const restored = current.filter((key) => locked.has(key));
  return roles
    .map((role) => role.key)
    .filter((key) => kept.includes(key) || restored.includes(key));
}

export function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

/** A business action in the editor: off, on in NocoProject's own scope ("related"), or on every record. */
export type BusinessChoice = 'off' | 'related' | 'all';

/** What the role editor edits, keyed like the grants: `page id`, `settings id/action`, `composite id/action`. */
export interface RoleDraft {
  readonly pages: ReadonlySet<string>;
  readonly settings: ReadonlySet<string>;
  readonly business: Readonly<Record<string, BusinessChoice>>;
}

type CatalogAction = AccessCatalog['business'][number]['actions'][number];

/** The data scopes of an action that offer a choice; one without options (creating a record) takes no policy. */
function choosable(action: CatalogAction): CatalogAction['scopes'] {
  return action.scopes.filter((scope) => scope.options.length > 0);
}

/** Whether an action offers a scope other than every record. */
export function offersRelated(action: CatalogAction): boolean {
  return choosable(action).some((scope) =>
    scope.options.some((option) => option !== ALL_RECORDS),
  );
}

/** Whether an action offers "every record" (an action without data scopes is not scoped at all). */
export function offersAll(action: CatalogAction): boolean {
  return choosable(action).some((scope) => scope.options.includes(ALL_RECORDS));
}

function choiceOf(
  action: CatalogAction,
  granted: AccessGrantAction | undefined,
): BusinessChoice {
  if (!granted) return 'off';
  const scopes = choosable(action);
  if (scopes.length === 0) return 'related';
  const all = scopes.every(
    (scope) =>
      (granted.policy?.scopes[scope.key] ?? scope.defaultValue) === ALL_RECORDS,
  );
  return all ? 'all' : 'related';
}

/** The editor's state from a role's grants; grants outside the catalog (retired pages) are dropped. */
export function draftFromGrants(
  catalog: AccessCatalog,
  grants: readonly AccessGrant[],
): RoleDraft {
  const actionsOf = (type: string, id: string): readonly AccessGrantAction[] =>
    grants
      .filter(
        (grant) => grant.resource.type === type && grant.resource.id === id,
      )
      .flatMap((grant) => grant.actions);
  const pages = new Set(
    catalog.pages.filter((id) =>
      actionsOf('page', id).some((entry) => entry.action === 'access'),
    ),
  );
  const settings = new Set<string>();
  for (const item of catalog.settings)
    for (const action of item.actions)
      if (actionsOf('settings', item.id).some((e) => e.action === action.name))
        settings.add(`${item.id}/${action.name}`);
  const business: Record<string, BusinessChoice> = {};
  for (const item of catalog.business)
    for (const action of item.actions)
      business[`${item.id}/${action.name}`] = choiceOf(
        action,
        actionsOf('composite', item.id).find((e) => e.action === action.name),
      );
  return { pages, settings, business };
}

/** The record access "related" selects for one scope: its default, else its first option that is not every record. */
function relatedOf(scope: CatalogAction['scopes'][number]): string {
  return scope.defaultValue && scope.defaultValue !== ALL_RECORDS
    ? scope.defaultValue
    : (scope.options.find((option) => option !== ALL_RECORDS) ?? ALL_RECORDS);
}

/** The record access an action's "related" choice stands for (its first scope's), for its label. */
export function relatedAccessOf(action: CatalogAction): string | undefined {
  const scope = choosable(action).find(
    (item) => relatedOf(item) !== ALL_RECORDS,
  );
  return scope ? relatedOf(scope) : undefined;
}

function scopesFor(
  action: CatalogAction,
  choice: BusinessChoice,
): Record<string, string> {
  return Object.fromEntries(
    choosable(action).map((scope) => [
      scope.key,
      choice === 'all' ? ALL_RECORDS : relatedOf(scope),
    ]),
  );
}

/** The grants a draft stands for, in the permission sets' own shape; every scope of an action is chosen explicitly. */
export function grantsFromDraft(
  catalog: AccessCatalog,
  draft: RoleDraft,
): AccessGrant[] {
  const grants: AccessGrant[] = [];
  for (const id of catalog.pages)
    if (draft.pages.has(id))
      grants.push({
        resource: { type: 'page', id },
        actions: [{ action: 'access' }],
      });
  for (const item of catalog.settings) {
    const actions = item.actions
      .filter((action) => draft.settings.has(`${item.id}/${action.name}`))
      .map((action) => ({ action: action.name }));
    if (actions.length > 0)
      grants.push({ resource: { type: 'settings', id: item.id }, actions });
  }
  for (const item of catalog.business) {
    const actions: AccessGrantAction[] = [];
    for (const action of item.actions) {
      const choice = draft.business[`${item.id}/${action.name}`] ?? 'off';
      if (choice === 'off') continue;
      actions.push(
        choosable(action).length === 0
          ? { action: action.name }
          : {
              action: action.name,
              policy: { type: 'composite', scopes: scopesFor(action, choice) },
            },
      );
    }
    if (actions.length > 0)
      grants.push({ resource: { type: 'composite', id: item.id }, actions });
  }
  return grants;
}

/** The locale key for a failed role write, by the server's error code. */
export function roleErrorKey(code: string | undefined, status: number): string {
  switch (code) {
    case 'NOT_NP_ROLE':
      return 'np.roles.errors.notNpRole';
    case 'ROLE_HAS_PLATFORM_GRANTS':
      return 'np.roles.errors.platformGrants';
    case 'LAST_OWNER':
      return 'np.roles.errors.lastOwner';
    case 'ROLE_IN_USE':
      return 'np.roles.errors.inUse';
    case 'ROLE_BUILT_IN':
      return 'np.roles.errors.builtIn';
    case 'ROLE_NOT_EDITABLE':
      return 'np.roles.errors.notEditable';
    case 'GRANT_NOT_ALLOWED':
      return 'np.roles.errors.grantNotAllowed';
    case 'USER_DISABLED':
      return 'np.roles.errors.userDisabled';
    case 'INVALID_TITLE':
      return 'np.roles.errors.invalidTitle';
    default:
      return status === 403 ? 'np.common.forbidden' : 'np.common.requestFailed';
  }
}
