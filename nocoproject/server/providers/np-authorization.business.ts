/**
 * NocoProject's business actions on the authorization plugin (NP-153 stage 1, `server/modules/shared/access.ts`
 * `NP_BUSINESS`).
 *
 * Each action is a composite over one NocoProject collection with one data scope, which offers exactly two record
 * accesses: NocoProject's own (`nocoproject.*` below, the default) and the built-in `allRecords`. The services never
 * run the resulting database policies: they read the three-state `NpScope` of `scopeOfDecision` and keep implementing
 * "related" with their own SQL (`shared/authz.ts`). The record access resolvers therefore only describe that rule to
 * the permission workspace's inspector, as closely as a filter on the collection's own columns can; NocoProject's SQL
 * is what is enforced. A resolver never answers `true` (that would read as "all") and answers `false` only for a
 * principal that is not a user.
 */
import {
  defineDatabasePermission,
  recordAccess,
  type AppAuthorization,
  type AuthorizationContext,
} from '@nocobase/app-plugin-authorization/server';
import {
  defineCompositeResource,
  defineRecordAccess,
  type AuthorizationDecision,
  type RecordAccessReference,
} from '@nocobase/authorization/core';
import { buildFilter } from '@nocobase/repository-input';

import {
  NP_BUSINESS,
  NP_BUSINESS_KEYS,
  type NpScope,
  type NpScopes,
} from '../modules/shared/access.js';

const NS = 'nocoproject';
/** The workspace subsection of the business actions, under Business. */
export const BUSINESS_SECTION = 'nocoproject.business';

function title(key: string): { key: string; ns: string } {
  return { key: `np.access.${key}`, ns: NS };
}

/** The collections the business actions compose; registering one grants nothing. */
const COLLECTIONS = [
  'projects',
  'issues',
  'agents',
  'skills',
  'intakeBatches',
] as const;

type Collection = (typeof COLLECTIONS)[number];

type Principal = { readonly type: string; readonly id: string };

const visible = defineRecordAccess('nocoproject.visible', (access) =>
  access
    .title(title('recordAccess.visible'))
    .collections('projects', 'issues')
    .resolver(
      ({
        principal,
        collection,
      }: {
        principal: Principal;
        collection: string;
      }) => {
        if (principal.type !== 'user') return false;
        return collection === 'projects'
          ? buildFilter((f) =>
              f.or([
                f.string('visibility').ne('members'),
                f.string('leadUserId').eq(principal.id),
              ]),
            )
          : buildFilter((f) =>
              f.or([
                f.string('projectId').eq(null),
                f.string('ownerUserId').eq(principal.id),
              ]),
            );
      },
    ),
);

const managed = defineRecordAccess('nocoproject.managed', (access) =>
  access
    .title(title('recordAccess.managed'))
    .collections('projects', 'issues')
    .resolver(
      ({
        principal,
        collection,
      }: {
        principal: Principal;
        collection: string;
      }) => {
        if (principal.type !== 'user') return false;
        const field = collection === 'projects' ? 'leadUserId' : 'ownerUserId';
        return buildFilter((f) => f.string(field).eq(principal.id));
      },
    ),
);

const OWNER_FIELDS: Readonly<Record<string, string>> = {
  agents: 'ownerUserId',
  skills: 'createdById',
  intakeBatches: 'createdById',
};

const own = defineRecordAccess('nocoproject.own', (access) =>
  access
    .title(title('recordAccess.own'))
    .collections('agents', 'skills', 'intakeBatches')
    .resolver(
      ({
        principal,
        collection,
      }: {
        principal: Principal;
        collection: string;
      }) => {
        if (principal.type !== 'user') return false;
        const field = OWNER_FIELDS[collection] ?? 'createdById';
        return buildFilter((f) => f.string(field).eq(principal.id));
      },
    ),
);

const VISIBLE = visible.reference();
const MANAGED = managed.reference();
const OWN = own.reference();

type Operation = 'read' | 'create' | 'update' | 'delete';

/**
 * One grant on `collection` under the data scope named after it. `related` is NocoProject's record access (the
 * default); without it the action offers only "all".
 */
function scoped(
  collection: Collection,
  operation: Operation,
  related: RecordAccessReference | null,
) {
  const base = defineDatabasePermission((p) => {
    const table = p.collection(collection);
    if (operation === 'read') return table.read('*');
    if (operation === 'create') return table.create('*');
    if (operation === 'update') return table.update('*');
    return table.delete();
  });
  return related
    ? base.options(related, recordAccess.allRecords).default(related)
    : base.options(recordAccess.allRecords).default(recordAccess.allRecords);
}

const projects = defineCompositeResource(NP_BUSINESS.projects, (r) =>
  r
    .title(title('business.projects'))
    .action('view', (a) =>
      a
        .title(title('business.view'))
        .grant('projects', scoped('projects', 'read', VISIBLE)),
    )
    .action('create', (a) =>
      a.title(title('business.create')).grant(
        'projects',
        defineDatabasePermission((p) => p.collection('projects').create('*')),
      ),
    )
    .action('manage', (a) =>
      a
        .title(title('business.manage'))
        .grant('projects', scoped('projects', 'update', MANAGED)),
    )
    .action('delete', (a) =>
      a
        .title(title('business.delete'))
        .grant('projects', scoped('projects', 'delete', null)),
    ),
);

const issues = defineCompositeResource(NP_BUSINESS.issues, (r) =>
  r
    .title(title('business.issues'))
    .action('view', (a) =>
      a
        .title(title('business.view'))
        .grant('issues', scoped('issues', 'read', VISIBLE)),
    )
    .action('edit', (a) =>
      a
        .title(title('business.edit'))
        .grant('issues', scoped('issues', 'update', VISIBLE)),
    )
    .action('close', (a) =>
      a
        .title(title('business.close'))
        .grant('issues', scoped('issues', 'update', MANAGED)),
    )
    .action('change-owner', (a) =>
      a
        .title(title('business.changeOwner'))
        .grant('issues', scoped('issues', 'update', MANAGED)),
    ),
);

const pullRequests = defineCompositeResource(NP_BUSINESS.pullRequests, (r) =>
  r
    .title(title('business.pullRequests'))
    .action('merge', (a) =>
      a
        .title(title('business.merge'))
        .grant('issues', scoped('issues', 'update', MANAGED)),
    ),
);

const agents = defineCompositeResource(NP_BUSINESS.agents, (r) =>
  r
    .title(title('business.agents'))
    .action('manage', (a) =>
      a
        .title(title('business.manage'))
        .grant('agents', scoped('agents', 'update', OWN)),
    )
    .action('env', (a) =>
      a
        .title(title('business.env'))
        .grant('agents', scoped('agents', 'update', OWN)),
    ),
);

const knowledge = defineCompositeResource(NP_BUSINESS.knowledge, (r) =>
  r
    .title(title('business.knowledge'))
    .action('decide', (a) =>
      a
        .title(title('business.decide'))
        .grant('projects', scoped('projects', 'update', MANAGED)),
    ),
);

const skills = defineCompositeResource(NP_BUSINESS.skills, (r) =>
  r
    .title(title('business.skills'))
    .action('manage', (a) =>
      a
        .title(title('business.manage'))
        .grant('skills', scoped('skills', 'update', OWN)),
    ),
);

const intake = defineCompositeResource(NP_BUSINESS.intake, (r) =>
  r
    .title(title('business.intake'))
    .action('manage', (a) =>
      a
        .title(title('business.manage'))
        .grant('intakeBatches', scoped('intakeBatches', 'update', OWN)),
    ),
);

const reports = defineCompositeResource(NP_BUSINESS.reports, (r) =>
  r
    .title(title('business.reports'))
    .action('view', (a) =>
      a
        .title(title('business.view'))
        .grant('projects', scoped('projects', 'read', VISIBLE)),
    ),
);

export const NP_BUSINESS_RESOURCES = [
  projects,
  issues,
  pullRequests,
  agents,
  knowledge,
  skills,
  intake,
  reports,
] as const;

/** Registers the collections, record accesses and composites, listed under Business → NocoProject. */
export function registerNpBusiness(authz: AppAuthorization): void {
  for (const name of COLLECTIONS)
    authz.database.collections.add({
      name,
      title: title(`collections.${name}`),
    });
  for (const access of [visible, managed, own])
    authz.recordAccess.define(access);
  authz.ui.sections.add({
    name: BUSINESS_SECTION,
    title: title('section'),
    parent: 'business',
  });
  // Built first: the builders' typed references differ, their definitions do not.
  for (const definition of NP_BUSINESS_RESOURCES.map((resource) =>
    resource.build(),
  ))
    authz.ui.place(authz.compositeResources.define(definition), {
      section: BUSINESS_SECTION,
    });
}

interface CompositeCheck {
  readonly decision: AuthorizationDecision;
}

/**
 * The three states of a composite decision. The database adapter answers every collection check `conditional` (even
 * for `allRecords` and unrestricted callers), so a composite is never `permit`; "all" is read from its checks instead:
 * every underlying check reaches every record (`scope: true`). Anything narrower — NocoProject's record access, a
 * restriction rule, a sharing rule on top of it — is "related", enforced by NocoProject's own rules. A check that
 * reaches nothing (an empty selection) leaves "none".
 */
export function scopeOfDecision(decision: AuthorizationDecision): NpScope {
  if (decision.effect === 'deny') return 'none';
  if (decision.effect === 'permit') return 'all';
  const checks = (
    decision.conditions as { checks?: readonly CompositeCheck[] } | undefined
  )?.checks;
  if (!checks?.length) return 'related';
  if (checks.every((check) => check.decision.effect === 'deny')) return 'none';
  const all = checks.every(
    (check) =>
      check.decision.effect !== 'deny' &&
      (check.decision.conditions as { scope?: unknown } | undefined)?.scope ===
        true,
  );
  return all ? 'all' : 'related';
}

/**
 * Every business scope of one request's caller, decided together (about 10 ms on SQLite, most of it evaluating the
 * record access and rules of each check; `can` alone would not tell "all" from "related"). On the application's own
 * connection, so the caller resolves it before any transaction.
 */
export async function resolveScopes(
  context: AuthorizationContext,
): Promise<NpScopes> {
  const decided = await Promise.all(
    NP_BUSINESS_KEYS.map(
      async ({ composite, action, key }) =>
        [
          key,
          scopeOfDecision(
            await context.authorize({
              resource: { type: 'composite', id: composite },
              action,
            }),
          ),
        ] as const,
    ),
  );
  return Object.fromEntries(decided) as unknown as NpScopes;
}
