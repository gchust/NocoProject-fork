/**
 * The business roles of `/config/members` on the permission-set service (NP-153 stage 2, `modules/member/
 * roles.service.ts`): `RoleStore` over `authz.permissionSets`, and the catalog of what a role may hold, built from
 * NocoProject's own registrations (`np-authorization.ts`, `np-authorization.business.ts`) and page list
 * (`shared/access.ts` `NP_PAGES`). Nothing platform-owned is listed: the permission workspace shows those.
 */
import type { AppAuthorization } from '@nocobase/app-plugin-authorization/server';
import {
  PermissionSetConflictError,
  PermissionSetNotFoundError,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';

import type { RoleStore, StoredRole } from '../modules/member/member.roles.js';
import { NP_PAGES, NP_SETTINGS_ACTIONS } from '../modules/shared/access.js';
import { conflict, notFound } from '../modules/shared/errors.js';
import type {
  AccessCatalog,
  AccessGrant,
  AccessTitle,
} from '../modules/shared/protocol.js';

import { NP_BUSINESS_RESOURCES } from './np-authorization.business.js';
import {
  replaceAssignments,
  SETTINGS_TITLES,
  title,
} from './np-authorization.js';

const ALL_RECORDS = 'allRecords';

const RECORD_ACCESS: readonly { key: string; title: AccessTitle | null }[] = [
  { key: ALL_RECORDS, title: null },
  { key: 'nocoproject.visible', title: title('recordAccess.visible') },
  { key: 'nocoproject.managed', title: title('recordAccess.managed') },
  { key: 'nocoproject.own', title: title('recordAccess.own') },
];

/** Everything a business role may hold; the same for every caller, so built once. */
export function buildAccessCatalog(): AccessCatalog {
  return {
    pages: [...NP_PAGES],
    settings: Object.entries(NP_SETTINGS_ACTIONS).map(([id, actions]) => ({
      id,
      title: title(`settings.${SETTINGS_TITLES[id]}`),
      actions: actions.map((name) => ({
        name,
        title: title(`actions.${name}`),
      })),
    })),
    business: NP_BUSINESS_RESOURCES.map((resource) => {
      const definition = resource.build();
      return {
        id: definition.name,
        title: definition.title ?? null,
        actions: definition.actions.map((action) => ({
          name: action.name,
          title: action.title ?? null,
          scopes: (action.dataScopes ?? []).map((scope) => ({
            key: scope.key,
            title: scope.title ?? null,
            options: [...(scope.options ?? [])],
            defaultValue: scope.defaultValue ?? null,
          })),
        })),
      };
    }),
    recordAccess: RECORD_ACCESS,
  };
}

function stored(set: PermissionSet): StoredRole {
  return {
    key: set.key,
    ...(set.title === undefined ? {} : { title: set.title }),
    grants: set.grants as readonly AccessGrant[],
  };
}

function written(role: StoredRole) {
  return {
    key: role.key,
    ...(role.title === undefined ? {} : { title: role.title }),
    grants: role.grants.map((grant) => ({
      resource: grant.resource,
      actions: grant.actions.map((action) =>
        action.policy
          ? { action: action.action, policy: { ...action.policy } }
          : { action: action.action },
      ),
    })),
  };
}

function mapped<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof PermissionSetNotFoundError) throw notFound('Role');
    if (error instanceof PermissionSetConflictError)
      throw conflict('ROLE_EXISTS', 'A role with this key already exists.');
    throw error;
  });
}

/**
 * `RoleStore` on the permission-set service. Writes to the sets themselves go through the unbound service, which
 * announces them to every holder; `replace` is bound to the caller's transaction, whose owner announces it after
 * commit (`RoleAssignments.changed`).
 */
export function createPermissionSetRoles(authz: AppAuthorization): RoleStore {
  const catalog = buildAccessCatalog();
  const sets = authz.permissionSets;
  return {
    catalog: () => catalog,
    list: async (conn) => (await sets.withTransaction(conn).list()).map(stored),
    assignments: async (conn) =>
      (await sets.withTransaction(conn).listAssignments()).map(
        ({ subject, permissionSet }) => ({ subject, permissionSet }),
      ),
    create: (role) =>
      mapped(async () => stored(await sets.create(written(role)))),
    update: (key, role) =>
      mapped(async () => stored(await sets.update(key, written(role)))),
    delete: (key) => mapped(() => sets.delete(key)),
    replace: (conn, userId, managed, keys) =>
      replaceAssignments(sets.withTransaction(conn), userId, managed, keys),
  };
}
