// @vitest-environment node
/**
 * NP-153 stage 1 on the services (PostgreSQL): every rule that used to let owner/admin through now reads a business
 * scope (`shared/access.ts` `NP_BUSINESS`), and each is exercised at `all`, `related` and `none`. The scopes come from
 * `tests/logic/np-role-double.ts` (owner/admin all, members related), overridden per user with `grantScopes` the way
 * an administrator edits a role. The whole-application counterpart is `np-business-access-app.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import {
  businessKey,
  NP_BUSINESS,
  RELATED_SCOPES,
  type NpBusinessKey,
  type NpScope,
} from '../../server/modules/shared/access.ts';
import {
  allowsOwn,
  canEditAgent,
  canMergePullRequest,
  deciderUserIds,
  reportHiddenProjectIds,
  scopeOf,
  viewerOf,
  type Viewer,
} from '../../server/modules/shared/authz.ts';
import {
  scopeOf as knowledgeScopeOf,
  canEdit,
} from '../../server/modules/knowledge/knowledge.access.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  openNpTestDatabase,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  grantScopes,
  MEMBER_SCOPES,
  membersTableRoles,
  resetScopes,
  withAccess,
} from './np-role-double.ts';

const opened = await openNpTestDatabase('np_t_business_scopes');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn('[np-business-scopes] skipped:', skip);
const db = (skip ? null : opened) as NpTestDatabase | null;
afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let privateProject: string;
let aliceIssue: { id: string; revision: number };
let bobIssue: { id: string; revision: number };

const key = businessKey;
const P = NP_BUSINESS.projects;
const I = NP_BUSINESS.issues;

function grant(userId: string, entries: [NpBusinessKey, NpScope][]): void {
  grantScopes(userId, Object.fromEntries(entries));
}

beforeEach(async () => {
  if (!db) return;
  resetScopes();
  await resetData(db);
  ({ services } = buildServices(db.database));
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  privateProject = (
    await services.projects.create(ALICE, {
      name: 'Private',
      visibility: 'members',
    })
  ).id;
  aliceIssue = await services.issues.create(ALICE, {
    title: 'Secret',
    projectId: privateProject,
  });
  bobIssue = await services.issues.create(BOB, { title: 'Open' });
});

async function refused(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

function viewer(scopes: Partial<Record<NpBusinessKey, NpScope>>): Viewer {
  return {
    userId: BOB.id ?? '',
    role: 'member',
    scopes: { ...MEMBER_SCOPES, ...scopes },
  };
}

describe.skipIf(!db)(
  'business scopes replace the owner/admin bypass (PostgreSQL)',
  () => {
    it('gives an actor without the built-in authorization "related", never "all"', async () => {
      const conn = db!.database.connection();
      // ALICE is an owner in members.role, but a bare actor (an internal one) carries no access.
      expect(await scopeOf(ALICE, P, 'delete')).toBe('related');
      expect((await viewerOf(conn, ALICE)).scopes).toEqual(RELATED_SCOPES);
      expect(await scopeOf(withAccess(db!.database, ALICE), P, 'delete')).toBe(
        'all',
      );
      expect(await scopeOf(withAccess(db!.database, BOB), P, 'delete')).toBe(
        'none',
      );
      expect(await scopeOf({ type: 'agent', id: 'a1' }, I, 'view')).toBe(
        'related',
      );
    });

    it('projects: view, create, manage and delete', async () => {
      const names = async () =>
        (await services.projects.list(BOB)).map((project) => project.name);
      // view: related hides a private project the viewer did not join; all shows it; none shows nothing.
      expect(await names()).not.toContain('Private');
      await refused(services.projects.get(BOB, privateProject), 'NOT_FOUND');
      grant(BOB.id!, [[key(P, 'view'), 'all']]);
      expect(await names()).toContain('Private');
      await services.projects.create(ALICE, { name: 'Public' });
      grant(BOB.id!, [[key(P, 'view'), 'none']]);
      expect(await names()).toEqual([]);
      await refused(services.projects.get(BOB, privateProject), 'NOT_FOUND');

      // create: any scope but none.
      await services.projects.create(BOB, { name: 'Mine' });
      grant(BOB.id!, [[key(P, 'create'), 'none']]);
      await refused(services.projects.create(BOB, { name: 'No' }), 'FORBIDDEN');

      // manage: related is the lead, all every project, none not even the lead.
      grant(BOB.id!, [[key(P, 'view'), 'all']]);
      await refused(
        services.projects.update(BOB, privateProject, { name: 'Renamed' }),
        'FORBIDDEN',
      );
      grant(BOB.id!, [[key(P, 'manage'), 'all']]);
      await services.projects.update(BOB, privateProject, { name: 'Renamed' });
      grant(ALICE.id!, [[key(P, 'manage'), 'none']]);
      await refused(
        services.projects.update(ALICE, privateProject, { name: 'Again' }),
        'FORBIDDEN',
      );

      // delete: only "all"; members hold none.
      await refused(services.projects.remove(BOB, privateProject), 'FORBIDDEN');
      grant(BOB.id!, [[key(P, 'delete'), 'all']]);
      await services.projects.remove(BOB, privateProject);
    });

    it('issues: view, edit, close and change-owner', async () => {
      const listed = async () =>
        (await services.issueQueries.list(BOB, {})).map((issue) => issue.id);
      // view: related sees issues outside the private project, all sees every issue, none sees nothing.
      expect(await listed()).toEqual([bobIssue.id]);
      await refused(
        services.issueQueries.detail(BOB, aliceIssue.id),
        'NOT_FOUND',
      );
      grant(BOB.id!, [[key(I, 'view'), 'all']]);
      expect((await listed()).sort()).toEqual(
        [aliceIssue.id, bobIssue.id].sort(),
      );
      await services.issueQueries.detail(BOB, aliceIssue.id);
      grant(BOB.id!, [[key(I, 'view'), 'none']]);
      expect(await listed()).toEqual([]);
      await refused(
        services.issueQueries.detail(BOB, bobIssue.id),
        'NOT_FOUND',
      );

      // edit: none refuses creating, changing fields, commenting and dependencies.
      grant(BOB.id!, [
        [key(I, 'view'), 'related'],
        [key(I, 'edit'), 'none'],
      ]);
      await refused(services.issues.create(BOB, { title: 'No' }), 'FORBIDDEN');
      await refused(
        services.issues.update(BOB, bobIssue.id, {
          title: 'No',
          revision: bobIssue.revision,
        }),
        'FORBIDDEN',
      );
      await refused(
        services.comments.create(BOB, bobIssue.id, { content: 'No' }),
        'FORBIDDEN',
      );
      const other = await services.issues.create(CAROL, { title: 'Other' });
      await refused(
        services.dependencies.add(BOB, bobIssue.id, {
          type: 'relatedTo',
          dependsOnIssueId: other.id,
        }),
        'FORBIDDEN',
      );
      grant(BOB.id!, [[key(I, 'edit'), 'related']]);
      await services.comments.create(BOB, bobIssue.id, { content: 'Yes' });

      // close: related is the issue owner (or project lead), all any issue, none not even the owner.
      await refused(
        services.issues.update(CAROL, bobIssue.id, {
          statusKey: 'cancelled',
          revision: bobIssue.revision,
        }),
        'FORBIDDEN',
      );
      grant(BOB.id!, [[key(I, 'close'), 'none']]);
      await refused(
        services.issues.update(BOB, bobIssue.id, {
          statusKey: 'cancelled',
          revision: bobIssue.revision,
        }),
        'FORBIDDEN',
      );
      grant(CAROL.id!, [[key(I, 'close'), 'all']]);
      await services.issues.update(CAROL, bobIssue.id, {
        statusKey: 'cancelled',
        revision: bobIssue.revision,
      });

      // change-owner: the same three states.
      const [row] = await rows(db!, 'issues', 'id = ?', [bobIssue.id]);
      const revision = Number(row?.revision);
      await refused(
        services.issues.update(CAROL, bobIssue.id, {
          ownerUserId: CAROL.id!,
          revision,
        }),
        'FORBIDDEN',
      );
      grant(BOB.id!, [[key(I, 'change-owner'), 'none']]);
      await refused(
        services.issues.update(BOB, bobIssue.id, {
          ownerUserId: CAROL.id!,
          revision,
        }),
        'FORBIDDEN',
      );
      grant(CAROL.id!, [[key(I, 'change-owner'), 'all']]);
      await services.issues.update(CAROL, bobIssue.id, {
        ownerUserId: CAROL.id!,
        revision,
      });
    });

    it('pull request merge, agents, skills and intake follow their own scopes', async () => {
      const conn = db!.database.connection();
      const own = { ownerUserId: BOB.id!, projectId: null };
      const others = { ownerUserId: CAROL.id!, projectId: null };
      const merge = NP_BUSINESS.pullRequests;
      expect(await canMergePullRequest(conn, viewer({}), own)).toBe(true);
      expect(await canMergePullRequest(conn, viewer({}), others)).toBe(false);
      expect(
        await canMergePullRequest(
          conn,
          viewer({ [key(merge, 'merge')]: 'all' }),
          others,
        ),
      ).toBe(true);
      expect(
        await canMergePullRequest(
          conn,
          viewer({ [key(merge, 'merge')]: 'none' }),
          own,
        ),
      ).toBe(false);

      const agents = NP_BUSINESS.agents;
      const mine = { ownerUserId: BOB.id! };
      const theirs = { ownerUserId: CAROL.id! };
      expect(canEditAgent(viewer({}), mine)).toBe(true);
      expect(canEditAgent(viewer({}), theirs)).toBe(false);
      expect(
        canEditAgent(viewer({ [key(agents, 'manage')]: 'all' }), theirs),
      ).toBe(true);
      expect(
        canEditAgent(viewer({ [key(agents, 'manage')]: 'none' }), mine),
      ).toBe(false);
      // env, skills and intake: all, own at related, nothing at none.
      for (const scope of ['all', 'related', 'none'] as const) {
        expect(allowsOwn(scope, BOB.id, BOB.id!)).toBe(scope !== 'none');
        expect(allowsOwn(scope, CAROL.id, BOB.id!)).toBe(scope === 'all');
      }
    });

    it('knowledge decisions, reports and deciders', async () => {
      const conn = db!.database.connection();
      const bob = withAccess(db!.database, BOB);
      // knowledge decide: related is the projects the viewer leads, all every document, none nothing.
      const led = (await services.projects.create(BOB, { name: 'Led by Bob' }))
        .id;
      let scope = await knowledgeScopeOf(conn, bob);
      expect(canEdit(scope, led)).toBe(true);
      expect(canEdit(scope, null)).toBe(false);
      grant(BOB.id!, [[key(NP_BUSINESS.knowledge, 'decide'), 'all']]);
      scope = await knowledgeScopeOf(conn, bob);
      expect(canEdit(scope, null)).toBe(true);
      grant(BOB.id!, [[key(NP_BUSINESS.knowledge, 'decide'), 'none']]);
      scope = await knowledgeScopeOf(conn, bob);
      expect(canEdit(scope, led)).toBe(false);

      // reports: related leaves out the private project, all keeps it, none refuses.
      const reports = key(NP_BUSINESS.reports, 'view');
      expect(await reportHiddenProjectIds(conn, viewer({}))).toEqual([
        privateProject,
      ]);
      expect(
        await reportHiddenProjectIds(conn, viewer({ [reports]: 'all' })),
      ).toEqual([]);
      await refused(
        reportHiddenProjectIds(conn, viewer({ [reports]: 'none' })),
        'FORBIDDEN',
      );
      await refused(
        services.usage.query((grant(BOB.id!, [[reports, 'none']]), BOB), {}),
        'FORBIDDEN',
      );

      // Deciders: the members holding the action on every record (the double: owner/admin).
      await setRole(db!, CAROL, 'admin');
      expect(
        (
          await deciderUserIds(conn, membersTableRoles, {
            resource: { type: 'composite', id: NP_BUSINESS.issues },
            action: 'close',
          })
        ).sort(),
      ).toEqual([ALICE.id, CAROL.id].sort());
    });
  },
);
