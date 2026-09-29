// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  draftFromGrants,
  grantsFromDraft,
  lockOf,
  nextRoles,
  PAGE_TITLES,
  roleErrorKey,
  roleOptions,
} from '../../client/pages/np/config/roles-model.js';
import type {
  AccessCatalog,
  BusinessRole,
} from '../../client/pages/np/types-roles.js';
import { buildAccessCatalog } from '../../server/providers/np-authorization.roles.js';
import { checkGrants } from '../../server/modules/member/roles.grants.js';
import { NP_PAGES } from '../../server/modules/shared/access.js';

const role = (
  key: string,
  holderIds: string[],
  extra: Partial<BusinessRole> = {},
): BusinessRole => ({
  key,
  title: key,
  builtIn: key.startsWith('np-r-') ? false : true,
  editable: key !== 'np-owner',
  hasForeignGrants: false,
  grants: [],
  holderIds,
  holderCount: holderIds.length,
  ...extra,
});

const ROLES = [
  role('np-owner', ['u1']),
  role('np-admin', ['u2']),
  role('np-member', ['u3']),
  role('np-r-ops', ['u2'], { hasForeignGrants: true }),
];

describe('member role choices (NP-153)', () => {
  it('lets only an owner add or remove owner, and never the last owner', () => {
    const owner = ROLES[0];
    expect(lockOf(owner, 'u3', 'u2', ROLES)).toBe('owner');
    expect(lockOf(owner, 'u3', 'u1', ROLES)).toBeNull();
    expect(lockOf(owner, 'u1', 'u1', ROLES)).toBe('lastOwner');
    const two = [role('np-owner', ['u1', 'u4']), ...ROLES.slice(1)];
    expect(lockOf(two[0], 'u1', 'u1', two)).toBeNull();
  });

  it('offers a role with platform grants only to its holders, locked', () => {
    expect(roleOptions(ROLES, 'u3', 'u1').map((o) => o.value)).toEqual([
      'np-owner',
      'np-admin',
      'np-member',
    ]);
    expect(roleOptions(ROLES, 'u2', 'u1')).toContainEqual({
      value: 'np-r-ops',
      disabled: true,
    });
  });

  it('puts locked roles back as they were', () => {
    // An admin removing everything from an admin who holds a platform role keeps that one.
    expect(nextRoles(ROLES, 'u2', 'u2', [])).toEqual(['np-r-ops']);
    // A non-owner cannot sneak the owner role in.
    expect(nextRoles(ROLES, 'u3', 'u2', ['np-member', 'np-owner'])).toEqual([
      'np-member',
    ]);
    expect(nextRoles(ROLES, 'u3', 'u1', ['np-member', 'np-owner'])).toEqual([
      'np-owner',
      'np-member',
    ]);
  });

  it('localizes the server refusals', () => {
    expect(roleErrorKey('LAST_OWNER', 409)).toBe('np.roles.errors.lastOwner');
    expect(roleErrorKey('NOT_NP_ROLE', 403)).toBe('np.roles.errors.notNpRole');
    expect(roleErrorKey('ROLE_HAS_PLATFORM_GRANTS', 409)).toBe(
      'np.roles.errors.platformGrants',
    );
    expect(roleErrorKey('FORBIDDEN', 403)).toBe('np.common.forbidden');
    expect(roleErrorKey(undefined, 500)).toBe('np.common.requestFailed');
  });
});

describe('role drafts (NP-153)', () => {
  const catalog = buildAccessCatalog() as unknown as AccessCatalog;

  it('titles every page the server offers', () => {
    expect(Object.keys(PAGE_TITLES).sort()).toEqual([...NP_PAGES].sort());
  });

  it('round-trips grants, drops retired resources and reads the scope of each action', () => {
    const draft = draftFromGrants(catalog, [
      {
        resource: { type: 'page', id: 'np-issues' },
        actions: [{ action: 'access' }],
      },
      {
        resource: { type: 'page', id: 'np-intake' },
        actions: [{ action: 'access' }],
      },
      {
        resource: { type: 'settings', id: 'nocoproject.members' },
        actions: [{ action: 'read' }],
      },
      {
        resource: { type: 'composite', id: 'nocoproject.issues' },
        actions: [
          { action: 'view' },
          {
            action: 'close',
            policy: { type: 'composite', scopes: { issues: 'allRecords' } },
          },
        ],
      },
      {
        resource: { type: 'composite', id: 'nocoproject.projects' },
        actions: [{ action: 'create' }],
      },
    ]);
    expect([...draft.pages]).toEqual(['np-issues']);
    expect([...draft.settings]).toEqual(['nocoproject.members/read']);
    expect(draft.business['nocoproject.issues/view']).toBe('related');
    expect(draft.business['nocoproject.issues/close']).toBe('all');
    expect(draft.business['nocoproject.issues/edit']).toBe('off');
    expect(draft.business['nocoproject.projects/create']).toBe('related');

    const grants = grantsFromDraft(catalog, draft);
    expect(grants.map((grant) => grant.resource.id)).toEqual([
      'np-issues',
      'nocoproject.members',
      'nocoproject.projects',
      'nocoproject.issues',
    ]);
    const issues = grants.find((g) => g.resource.id === 'nocoproject.issues')!;
    expect(issues.actions).toEqual([
      {
        action: 'view',
        policy: {
          type: 'composite',
          scopes: { issues: 'nocoproject.visible' },
        },
      },
      {
        action: 'close',
        policy: { type: 'composite', scopes: { issues: 'allRecords' } },
      },
    ]);
    // What the editor saves is what the server accepts, unchanged.
    expect(checkGrants(buildAccessCatalog(), grants)).toEqual(grants);
    // A scope-less action carries no policy.
    expect(
      grants.find((g) => g.resource.id === 'nocoproject.projects')!.actions,
    ).toEqual([{ action: 'create' }]);
  });
});

describe('the whole catalog (NP-153)', () => {
  const catalog = buildAccessCatalog() as unknown as AccessCatalog;

  it('saves every action in either scope as grants the server accepts', () => {
    for (const choice of ['related', 'all'] as const) {
      const draft = draftFromGrants(catalog, []);
      const everything = {
        pages: new Set(catalog.pages),
        settings: new Set(
          catalog.settings.flatMap((item) =>
            item.actions.map((action) => `${item.id}/${action.name}`),
          ),
        ),
        business: Object.fromEntries(
          Object.keys(draft.business).map((key) => [key, choice]),
        ),
      };
      const grants = grantsFromDraft(catalog, everything);
      expect(checkGrants(buildAccessCatalog(), grants)).toEqual(grants);
      const back = draftFromGrants(catalog, grants);
      expect(back.pages.size).toBe(catalog.pages.length);
      for (const item of catalog.business)
        for (const action of item.actions) {
          const key = `${item.id}/${action.name}`;
          const scopes = action.scopes.filter((s) => s.options.length > 0);
          const offersRelated = scopes.some((scope) =>
            scope.options.some((option) => option !== 'allRecords'),
          );
          const expected =
            scopes.length === 0
              ? 'related'
              : choice === 'related' && !offersRelated
                ? 'all'
                : choice;
          expect([key, back.business[key]]).toEqual([key, expected]);
        }
    }
  });
});
