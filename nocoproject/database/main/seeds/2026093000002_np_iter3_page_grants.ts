import { defineSeed, type SeedDefinition } from '@nocobase/db';
import type { Knex } from 'knex';

// Lets every signed-in user open the NocoProject pages added in iteration 3 (docs/phase1/iteration-3-contract.md §A,
// §G): page `access` for np-my-issues, np-knowledge, np-reports and np-config. The APIs behind them enforce their own
// rules (knowledge writes: project lead or owner/admin; settings writes, members roles and GitHub: owner/admin).
// Added to the default permission set `member`, which the authorization plugin assigns to `authenticated:*`.
//
// The settings items `np-members`, `np-settings` and `np-github` are no longer registered (the settings shell no
// longer shows NocoProject pages); their old grants stay in the member set and are harmless.
//
// Runs once, after the authorization plugin's own seeds (seed names sort across sources). It only appends grants that
// are missing, so administrator edits to the member set are preserved, and an administrator who later removes a
// grant is not overridden (seeds do not re-run). Without the authorization tables (the NocoProject integration test
// schemas) it does nothing.
const MEMBER_SET = 'member';
const PAGES = ['np-my-issues', 'np-knowledge', 'np-reports', 'np-config'];

interface Grant {
  readonly resource: { readonly type: string; readonly id: string };
  readonly actions: readonly { readonly action: string }[];
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

function wanted(): Grant[] {
  return PAGES.map((id) => ({
    resource: { type: 'page', id },
    actions: [{ action: 'access' }],
  }));
}

const seed: SeedDefinition = defineSeed({
  name: '2026093000002_np_iter3_page_grants',

  async run({ query, connection }) {
    const knex = await connection.client<Knex>();
    if (!(await knex.schema.hasTable('authorization_permission_sets'))) return;
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['id', 'grants'])
      .where('key', '=', MEMBER_SET)
      .executeTakeFirst();
    if (!row) return;
    const grants = decodeGrants(row.grants);
    const missing = wanted().filter(
      (grant) =>
        !grants.some(
          (existing) =>
            existing.resource?.type === grant.resource.type &&
            existing.resource?.id === grant.resource.id,
        ),
    );
    if (missing.length === 0) return;
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        // Same encoding as the authorization plugin's own seed.
        grants: JSON.stringify([...grants, ...missing]),
        updatedAt: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
  },
});

export default seed;
