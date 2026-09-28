import { defineSeed, type SeedDefinition } from '@nocobase/db';
import type { Knex } from 'knex';

// The GitHub connection page declares the settings item `np-github` (registered by server/providers/np.ts). The
// earlier seed 2026092900003_np_iter2_page_grants granted `read` on a provisional id, `np-integrations`, that was
// never registered. This seed replaces that grant with `read` on `np-github` in the default permission set `member`
// (the integrations API itself enforces owner/admin, like `np-members`).
//
// Runs once; appends `np-github` only when missing and removes only the provisional `np-integrations` entry, so
// administrator edits to the member set are preserved. Without the authorization tables (the NocoProject
// integration test schemas) it does nothing.
const MEMBER_SET = 'member';
const GRANT = { type: 'settings', id: 'np-github', action: 'read' };
const PROVISIONAL = 'np-integrations';

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

const seed: SeedDefinition = defineSeed({
  name: '2026092900004_np_github_settings_grant',

  async run({ query, connection }) {
    const knex = await connection.client<Knex>();
    if (!(await knex.schema.hasTable('authorization_permission_sets'))) return;
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['id', 'grants'])
      .where('key', '=', MEMBER_SET)
      .executeTakeFirst();
    if (!row) return;
    const grants = decodeGrants(row.grants).filter(
      (grant) =>
        !(
          grant.resource?.type === 'settings' &&
          grant.resource?.id === PROVISIONAL
        ),
    );
    const present = grants.some(
      (grant) =>
        grant.resource?.type === GRANT.type && grant.resource?.id === GRANT.id,
    );
    const next = present
      ? grants
      : [
          ...grants,
          {
            resource: { type: GRANT.type, id: GRANT.id },
            actions: [{ action: GRANT.action }],
          },
        ];
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        // Same encoding as the authorization plugin's own seed.
        grants: JSON.stringify(next),
        updatedAt: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
  },
});

export default seed;
