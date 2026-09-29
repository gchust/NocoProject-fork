/**
 * NP-153 stage 2: the catalog of what a business role may hold, and the grant checks against it.
 *
 * - `NP_PAGES` (the server's list of NocoProject pages) is exactly the page grants `client/routes.ts` declares: pages
 *   are not registered on the server, so this test is what keeps the two in step.
 * - The catalog lists NocoProject's own resources only; `checkGrants` refuses anything else (400 `GRANT_NOT_ALLOWED`).
 * - `splitGrants` tells NocoProject's grants from platform grants added in the permission workspace.
 */
import { describe, expect, it } from 'vitest';

import applicationRoutes from '../../client/routes.ts';
import {
  checkGrants,
  splitGrants,
} from '../../server/modules/member/roles.grants.ts';
import { NP_PAGES } from '../../server/modules/shared/access.ts';
import { buildAccessCatalog } from '../../server/providers/np-authorization.roles.ts';

/** Every `page` grant id declared anywhere in the route contribution. */
function pageGrants(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) pageGrants(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const route = value as {
    authz?: { resource?: { type?: string; id?: string } };
    children?: unknown;
    routes?: unknown;
  };
  if (route.authz?.resource?.type === 'page' && route.authz.resource.id)
    found.add(route.authz.resource.id);
  pageGrants(route.children, found);
  pageGrants(route.routes, found);
  return found;
}

const catalog = buildAccessCatalog();

function rejected(grants: unknown): unknown {
  try {
    checkGrants(catalog, grants);
    return null;
  } catch (error) {
    return error;
  }
}

describe('the business role catalog (NP-153)', () => {
  it('lists exactly the NocoProject pages of the client routes', () => {
    const declared = [...pageGrants(applicationRoutes)].filter((id) =>
      id.startsWith('np-'),
    );
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...NP_PAGES].sort());
    expect(catalog.pages).toEqual([...NP_PAGES]);
  });

  it('lists only NocoProject settings items and business actions', () => {
    expect(catalog.settings.map((item) => item.id)).toEqual([
      'nocoproject.general',
      'nocoproject.members',
      'nocoproject.workflows',
      'nocoproject.labels',
      'nocoproject.github',
    ]);
    expect(
      catalog.business.every((item) => item.id.startsWith('nocoproject.')),
    ).toBe(true);
    const close = catalog.business
      .find((item) => item.id === 'nocoproject.issues')
      ?.actions.find((action) => action.name === 'close');
    expect(close?.scopes).toEqual([
      expect.objectContaining({
        key: 'issues',
        options: ['nocoproject.managed', 'allRecords'],
        defaultValue: 'nocoproject.managed',
      }),
    ]);
  });

  it('accepts catalog grants and merges them per resource', () => {
    expect(
      checkGrants(catalog, [
        {
          resource: { type: 'page', id: 'np-issues' },
          actions: [{ action: 'access' }],
        },
        {
          resource: { type: 'composite', id: 'nocoproject.issues' },
          actions: [
            {
              action: 'view',
              policy: {
                type: 'composite',
                scopes: { issues: 'nocoproject.visible' },
              },
            },
          ],
        },
        {
          resource: { type: 'composite', id: 'nocoproject.issues' },
          actions: [
            {
              action: 'close',
              policy: { type: 'composite', scopes: { issues: 'allRecords' } },
            },
          ],
        },
        {
          resource: { type: 'settings', id: 'nocoproject.labels' },
          actions: [],
        },
      ]),
    ).toEqual([
      {
        resource: { type: 'page', id: 'np-issues' },
        actions: [{ action: 'access' }],
      },
      {
        resource: { type: 'composite', id: 'nocoproject.issues' },
        actions: [
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
        ],
      },
    ]);
  });

  it('refuses platform resources, unknown actions and foreign scopes', () => {
    const refusals = [
      [
        {
          resource: { type: 'page', id: 'users' },
          actions: [{ action: 'access' }],
        },
      ],
      [
        {
          resource: { type: 'page', id: 'api-keys' },
          actions: [{ action: 'access' }],
        },
      ],
      [
        {
          resource: { type: 'settings', id: 'workflow' },
          actions: [{ action: 'read' }],
        },
      ],
      [
        {
          resource: { type: 'collection', id: 'users' },
          actions: [{ action: 'read' }],
        },
      ],
      // A retired NocoProject page is NocoProject's, but no longer offered.
      [
        {
          resource: { type: 'page', id: 'np-intake' },
          actions: [{ action: 'access' }],
        },
      ],
      [
        {
          resource: { type: 'settings', id: 'nocoproject.general' },
          actions: [{ action: 'invite' }],
        },
      ],
      [
        {
          resource: { type: 'composite', id: 'nocoproject.issues' },
          actions: [
            {
              action: 'close',
              policy: {
                type: 'composite',
                scopes: { issues: 'nocoproject.own' },
              },
            },
          ],
        },
      ],
      [
        {
          resource: { type: 'composite', id: 'nocoproject.projects' },
          actions: [
            {
              action: 'create',
              policy: { type: 'composite', scopes: { projects: 'allRecords' } },
            },
          ],
        },
      ],
    ];
    for (const grants of refusals)
      expect(rejected(grants)).toMatchObject({ code: 'GRANT_NOT_ALLOWED' });
    expect(rejected({ resource: 'page' })).toMatchObject({
      code: 'INVALID_GRANTS',
    });
    expect(rejected([{ resource: { type: 'page' } }])).toMatchObject({
      code: 'INVALID_GRANTS',
    });
  });

  it('splits NocoProject grants from platform grants', () => {
    const page = {
      resource: { type: 'page', id: 'np-issues' },
      actions: [{ action: 'access' }],
    };
    const retired = {
      resource: { type: 'settings', id: 'np-github' },
      actions: [{ action: 'read' }],
    };
    const users = {
      resource: { type: 'page', id: 'users' },
      actions: [{ action: 'access' }],
    };
    const collection = {
      resource: { type: 'collection', id: 'posts' },
      actions: [{ action: 'read' }],
    };
    expect(splitGrants([page, users, retired, collection])).toEqual({
      np: [page, retired],
      foreign: [users, collection],
    });
  });
});
