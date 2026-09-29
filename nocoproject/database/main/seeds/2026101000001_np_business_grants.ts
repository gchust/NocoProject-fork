import { defineSeed, type SeedDefinition } from '@nocobase/db';
import type { Knex } from 'knex';

// NP-153 stage 1: the business actions (composites `nocoproject.*`, registered by
// server/providers/np-authorization.business.ts) replace the owner/admin bypass in the services.
//
// Gives the three NocoProject sets their business grants, so behaviour stays what it was:
// - `np-owner` and `np-admin`: every action on every record (`allRecords`), and `assign` / `define-roles` on the
//   settings item `nocoproject.members` (registered now, used by the role management of stage 2).
// - `np-member`: the everyday actions on NocoProject's own scopes (`nocoproject.visible`, `.managed`, `.own`); not
//   project deletion, `assign` or `define-roles`.
//
// Fills gaps only: a set that already has a grant on a composite keeps it as it is, a missing set is not created, and
// an existing `nocoproject.members` grant only gains the two new actions. Seeds run once, so nothing an administrator
// changes later is undone. Without the authorization tables (the NocoProject integration test schemas) it does
// nothing.
//
// Self-contained on purpose, like the other permission seeds: nothing is imported from server/.

interface Action {
  readonly action: string;
  readonly policy?: {
    readonly type: 'composite';
    readonly scopes: Readonly<Record<string, string>>;
  };
}

interface Grant {
  readonly resource: { readonly type: string; readonly id: string };
  readonly actions: readonly Action[];
}

const ALL = 'allRecords';
const VISIBLE = 'nocoproject.visible';
const MANAGED = 'nocoproject.managed';
const OWN = 'nocoproject.own';

/** Each composite action and its one data scope (null: the action has none); `member` is np-member's choice. */
const ACTIONS: readonly {
  readonly composite: string;
  readonly action: string;
  readonly scope: string | null;
  readonly member: string | null;
}[] = [
  { composite: 'projects', action: 'view', scope: 'projects', member: VISIBLE },
  { composite: 'projects', action: 'create', scope: null, member: ALL },
  {
    composite: 'projects',
    action: 'manage',
    scope: 'projects',
    member: MANAGED,
  },
  { composite: 'projects', action: 'delete', scope: 'projects', member: null },
  { composite: 'issues', action: 'view', scope: 'issues', member: VISIBLE },
  { composite: 'issues', action: 'edit', scope: 'issues', member: VISIBLE },
  { composite: 'issues', action: 'close', scope: 'issues', member: MANAGED },
  {
    composite: 'issues',
    action: 'change-owner',
    scope: 'issues',
    member: MANAGED,
  },
  {
    composite: 'pullRequests',
    action: 'merge',
    scope: 'issues',
    member: MANAGED,
  },
  { composite: 'agents', action: 'manage', scope: 'agents', member: OWN },
  { composite: 'agents', action: 'env', scope: 'agents', member: OWN },
  {
    composite: 'knowledge',
    action: 'decide',
    scope: 'projects',
    member: MANAGED,
  },
  { composite: 'skills', action: 'manage', scope: 'skills', member: OWN },
  {
    composite: 'intake',
    action: 'manage',
    scope: 'intakeBatches',
    member: OWN,
  },
  { composite: 'reports', action: 'view', scope: 'projects', member: VISIBLE },
];

function action(name: string, scope: string | null, value: string): Action {
  return scope
    ? {
        action: name,
        policy: { type: 'composite', scopes: { [scope]: value } },
      }
    : { action: name };
}

/** The composite grants of a set: `everything` gives every action at `allRecords`, otherwise np-member's choices. */
function businessGrants(everything: boolean): Grant[] {
  const grants = new Map<string, Action[]>();
  for (const entry of ACTIONS) {
    const value = everything ? ALL : entry.member;
    if (value === null) continue;
    const id = `nocoproject.${entry.composite}`;
    const actions = grants.get(id) ?? [];
    actions.push(action(entry.action, entry.scope, value));
    grants.set(id, actions);
  }
  return [...grants].map(([id, actions]) => ({
    resource: { type: 'composite', id },
    actions,
  }));
}

const MEMBERS_SETTINGS = 'nocoproject.members';
const ROLE_ACTIONS = ['assign', 'define-roles'] as const;

const SETS: readonly { readonly key: string; readonly admin: boolean }[] = [
  { key: 'np-owner', admin: true },
  { key: 'np-admin', admin: true },
  { key: 'np-member', admin: false },
];

function parseGrants(value: unknown): Grant[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as Grant[]) : [];
}

/** `grants` with the missing business grants (and, for admins, the members role actions) added. */
function completed(grants: readonly Grant[], admin: boolean): Grant[] {
  const has = (type: string, id: string) =>
    grants.some(
      (grant) => grant.resource.type === type && grant.resource.id === id,
    );
  const result = grants.map((grant) => {
    if (
      !admin ||
      grant.resource.type !== 'settings' ||
      grant.resource.id !== MEMBERS_SETTINGS
    )
      return grant;
    const missing = ROLE_ACTIONS.filter(
      (name) => !grant.actions.some((entry) => entry.action === name),
    );
    return missing.length
      ? {
          ...grant,
          actions: [
            ...grant.actions,
            ...missing.map((name) => ({ action: name })),
          ],
        }
      : grant;
  });
  if (admin && !has('settings', MEMBERS_SETTINGS))
    result.push({
      resource: { type: 'settings', id: MEMBERS_SETTINGS },
      actions: ROLE_ACTIONS.map((name) => ({ action: name })),
    });
  for (const grant of businessGrants(admin))
    if (!has(grant.resource.type, grant.resource.id)) result.push(grant);
  return result;
}

const seed: SeedDefinition = defineSeed({
  name: '2026101000001_np_business_grants',
  transaction: true,

  async run({ query, connection }) {
    const knex = await connection.client<Knex>();
    if (!(await knex.schema.hasTable('authorization_permission_sets'))) return;
    for (const set of SETS) {
      const row = await query
        .selectFrom('authorizationPermissionSets')
        .select(['id', 'grants'])
        .where('key', '=', set.key)
        .executeTakeFirst();
      if (!row) continue;
      const before = parseGrants(row.grants);
      const after = completed(before, set.admin);
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      await query
        .updateTable('authorizationPermissionSets')
        .set({ grants: JSON.stringify(after), updatedAt: new Date() })
        .where('id', '=', row.id)
        .execute();
    }
  },
});

export default seed;
