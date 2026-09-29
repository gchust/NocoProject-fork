import { defineSeed, type SeedDefinition } from '@nocobase/db';
import type { Knex } from 'knex';

// NP-117: member roles move onto the built-in permission sets (server/modules/shared/access.ts).
//
// 1. Creates the sets `np-member`, `np-admin` and `np-owner` when missing, with the grants of the NocoProject settings
//    items (`nocoproject.*`, registered by server/providers/np-authorization.ts): members read the tabs they could read
//    before, admins and owners also change them. An existing set of the same key is left as the administrator made it.
// 2. Carries the existing roles over, from what `members.role` says now: every members row gets `np-member`, `owner`
//    rows `np-owner`, `admin` rows `np-admin`. `members.role` is kept (the projection, and the way back).
// 3. An installation without any owner row (a new one) makes the users holding the platform `root` set its owners, so
//    the initial administrator is the owner rather than whoever happens to arrive first.
//
// Runs once, after the authorization plugin's seeds (seed names sort across sources: its root and member sets are
// 202608240001 / 202608250002). Missing assignments only are added, so rerunning adds nothing, and nothing an
// administrator changes later is undone (seeds do not re-run). Without the authorization tables (the NocoProject
// integration test schemas) it does nothing.
//
// Self-contained on purpose, like the page grant seeds: nothing is imported from server/modules.

const NS = 'nocoproject';
const ROOT_SET = 'root';

interface Grant {
  readonly resource: { readonly type: string; readonly id: string };
  readonly actions: readonly { readonly action: string }[];
}

function settings(id: string, actions: readonly string[]): Grant {
  return {
    resource: { type: 'settings', id },
    actions: actions.map((action) => ({ action })),
  };
}

const MEMBER_GRANTS: readonly Grant[] = [
  settings('nocoproject.general', ['read']),
  settings('nocoproject.members', ['read']),
  settings('nocoproject.workflows', ['read']),
  settings('nocoproject.labels', ['read']),
];

const ADMIN_GRANTS: readonly Grant[] = [
  settings('nocoproject.general', ['read', 'update']),
  settings('nocoproject.members', ['read', 'invite']),
  settings('nocoproject.workflows', ['read', 'update']),
  settings('nocoproject.labels', ['read', 'update']),
  settings('nocoproject.github', ['read', 'update']),
];

const SETS: readonly {
  readonly key: string;
  readonly title: string;
  readonly grants: readonly Grant[];
}[] = [
  { key: 'np-member', title: 'np.access.sets.member', grants: MEMBER_GRANTS },
  { key: 'np-admin', title: 'np.access.sets.admin', grants: ADMIN_GRANTS },
  { key: 'np-owner', title: 'np.access.sets.owner', grants: ADMIN_GRANTS },
];

const ROLE_SET: Readonly<Record<string, string>> = {
  owner: 'np-owner',
  admin: 'np-admin',
};

const seed: SeedDefinition = defineSeed({
  name: '2026100800002_np_role_permission_sets',
  transaction: true,

  async run({ query, connection }) {
    const knex = await connection.client<Knex>();
    if (!(await knex.schema.hasTable('authorization_permission_sets'))) return;
    const now = new Date();

    for (const set of SETS) {
      const existing = await query
        .selectFrom('authorizationPermissionSets')
        .select('id')
        .where('key', '=', set.key)
        .executeTakeFirst();
      if (existing) continue;
      await query
        .insertInto('authorizationPermissionSets')
        .values({
          id: crypto.randomUUID(),
          key: set.key,
          // Same encoding as the authorization plugin's own seeds.
          title: JSON.stringify({ key: set.title, ns: NS }),
          grants: JSON.stringify(set.grants),
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    }

    const wanted: { userId: string; key: string }[] = [];
    const members = await query
      .selectFrom('members')
      .select(['userId', 'role'])
      .execute();
    for (const member of members) {
      const userId = String(member.userId);
      wanted.push({ userId, key: 'np-member' });
      const roleSet = ROLE_SET[String(member.role)];
      if (roleSet) wanted.push({ userId, key: roleSet });
    }
    if (!members.some((member) => member.role === 'owner')) {
      const roots = await query
        .selectFrom('authorizationPermissionSetAssignments')
        .select('subjectId')
        .where('permissionSetKey', '=', ROOT_SET)
        .where('subjectType', '=', 'user')
        .execute();
      for (const root of roots)
        wanted.push({ userId: String(root.subjectId), key: 'np-owner' });
    }

    for (const { userId, key } of wanted) {
      const existing = await query
        .selectFrom('authorizationPermissionSetAssignments')
        .select('id')
        .where('permissionSetKey', '=', key)
        .where('subjectType', '=', 'user')
        .where('subjectId', '=', userId)
        .executeTakeFirst();
      if (existing) continue;
      await query
        .insertInto('authorizationPermissionSetAssignments')
        .values({
          id: `user:${userId}:${key}`,
          subjectType: 'user',
          subjectId: userId,
          permissionSetKey: key,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    }
  },
});

export default seed;
