import { defineSeed, type SeedDefinition } from '@nocobase/db';
import type { Knex } from 'knex';

// NP-153 stage 2: the NocoProject page grants move from the default permission set `member` (assigned to every
// signed-in user) to the business roles, so a page ticked or unticked in a role in `/config/members` takes effect.
//
// 1. Every NocoProject page grant `member` holds is added to `np-member`, `np-admin` and `np-owner`, where missing.
// 2. Those grants are removed from `member`, together with the retired page grants np-intake, np-usage and
//    np-approvals and the retired settings items np-members, np-settings, np-github and np-integrations. The retired
//    ones are not carried over: no route declares them any more (the old paths are redirects without a page grant), and
//    a grant the role catalog does not offer could not be shown or sent back from `/config`. `page:api-keys` stays in
//    `member` (every account creates its own API key there).
//
// Afterwards an account without any `np-` role (a platform-only account, or someone whose roles were all revoked)
// opens no NocoProject page; a newcomer still gets `np-member` on first contact.
//
// Runs once, after the seeds that created the grants and the sets. Missing grants only are added, so rerunning adds
// nothing, and a set that is missing is not created. Without the authorization tables (the NocoProject integration
// test schemas) it does nothing.
//
// Self-contained on purpose, like the other permission seeds: nothing is imported from server/.

const MEMBER_SET = 'member';
const ROLE_SETS = ['np-member', 'np-admin', 'np-owner'];

const PAGES = [
  'np-inbox',
  'np-my-issues',
  'np-pm',
  'np-issues',
  'np-projects',
  'np-agents',
  'np-runtimes',
  'np-skills',
  'np-knowledge',
  'np-reports',
  'np-config',
];

const RETIRED_PAGES = ['np-intake', 'np-usage', 'np-approvals'];

const RETIRED_SETTINGS = [
  'np-members',
  'np-settings',
  'np-github',
  'np-integrations',
];

interface Grant {
  readonly resource: { readonly type: string; readonly id: string };
  readonly actions: readonly unknown[];
}

/** Stored grants may arrive as an array or as (possibly repeatedly) serialized JSON text. */
function decodeGrants(value: unknown): Grant[] {
  let current = value;
  for (let depth = 0; depth < 3 && typeof current === 'string'; depth += 1) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(current) ? (current as Grant[]) : [];
}

function isPage(grant: Grant): boolean {
  return grant.resource?.type === 'page' && PAGES.includes(grant.resource.id);
}

function isRetired(grant: Grant): boolean {
  if (grant.resource?.type === 'page')
    return RETIRED_PAGES.includes(grant.resource.id);
  return (
    grant.resource?.type === 'settings' &&
    RETIRED_SETTINGS.includes(grant.resource.id)
  );
}

const seed: SeedDefinition = defineSeed({
  name: '2026101100001_np_page_grants_to_roles',
  transaction: true,

  async run({ query, connection }) {
    const knex = await connection.client<Knex>();
    if (!(await knex.schema.hasTable('authorization_permission_sets'))) return;
    const member = await query
      .selectFrom('authorizationPermissionSets')
      .select(['id', 'grants'])
      .where('key', '=', MEMBER_SET)
      .executeTakeFirst();
    if (!member) return;
    const grants = decodeGrants(member.grants);
    const pages = grants.filter(isPage);
    const now = new Date();

    for (const key of ROLE_SETS) {
      const row = await query
        .selectFrom('authorizationPermissionSets')
        .select(['id', 'grants'])
        .where('key', '=', key)
        .executeTakeFirst();
      if (!row) continue;
      const held = decodeGrants(row.grants);
      const missing = pages.filter(
        (page) =>
          !held.some(
            (grant) =>
              grant.resource?.type === 'page' &&
              grant.resource.id === page.resource.id,
          ),
      );
      if (missing.length === 0) continue;
      await query
        .updateTable('authorizationPermissionSets')
        // Same encoding as the authorization plugin's own seeds.
        .set({ grants: JSON.stringify([...held, ...missing]), updatedAt: now })
        .where('id', '=', row.id)
        .execute();
    }

    const kept = grants.filter((grant) => !isPage(grant) && !isRetired(grant));
    if (kept.length === grants.length) return;
    await query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify(kept), updatedAt: now })
      .where('id', '=', member.id)
      .execute();
  },
});

export default seed;
