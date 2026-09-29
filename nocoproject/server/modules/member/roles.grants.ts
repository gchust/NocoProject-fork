/**
 * What a business role may hold (NP-153 stage 2): the grants a request asks for are checked against the catalog
 * (`AccessCatalog`, NocoProject's own pages, settings items and business actions), and a stored set is split into its
 * NocoProject part, which `/config` shows and replaces, and its platform part, which it keeps untouched.
 */
import { isNpResource } from '../shared/access.js';
import { invalid } from '../shared/errors.js';
import type {
  AccessCatalog,
  AccessGrant,
  AccessGrantAction,
} from '../shared/protocol.js';

function notAllowed(message: string): never {
  throw invalid('GRANT_NOT_ALLOWED', message);
}

function malformed(): never {
  throw invalid(
    'INVALID_GRANTS',
    'grants must be a list of { resource: { type, id }, actions: [{ action, policy? }] }.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The catalog as lookups: `type:id` → action → the data scopes it offers (`key` → options). */
function offered(
  catalog: AccessCatalog,
): Map<string, Map<string, ReadonlyMap<string, readonly string[]>>> {
  const result = new Map<
    string,
    Map<string, ReadonlyMap<string, readonly string[]>>
  >();
  for (const id of catalog.pages)
    result.set(`page:${id}`, new Map([['access', new Map()]]));
  for (const item of catalog.settings)
    result.set(
      `settings:${item.id}`,
      new Map(item.actions.map((action) => [action.name, new Map()])),
    );
  for (const item of catalog.business)
    result.set(
      `composite:${item.id}`,
      new Map(
        item.actions.map((action) => [
          action.name,
          new Map(action.scopes.map((scope) => [scope.key, scope.options])),
        ]),
      ),
    );
  return result;
}

function checkPolicy(
  where: string,
  scopes: ReadonlyMap<string, readonly string[]>,
  policy: unknown,
): AccessGrantAction['policy'] {
  if (policy === undefined || policy === null) return undefined;
  if (scopes.size === 0) notAllowed(`${where} takes no data scope.`);
  if (
    !isRecord(policy) ||
    policy.type !== 'composite' ||
    !isRecord(policy.scopes)
  )
    notAllowed(`${where}: the policy must be { type: 'composite', scopes }.`);
  const chosen: Record<string, string> = {};
  for (const [key, value] of Object.entries(policy.scopes)) {
    const options = scopes.get(key);
    if (!options) notAllowed(`${where} has no data scope ${key}.`);
    if (typeof value !== 'string' || !options.includes(value))
      notAllowed(`${where}: ${key} cannot select ${String(value)}.`);
    chosen[key] = value;
  }
  return { type: 'composite', scopes: chosen };
}

/**
 * The grants of a role write, checked against the catalog: anything outside it (a platform resource, an unknown
 * action, a data scope NocoProject does not offer) is 400 `GRANT_NOT_ALLOWED`; a malformed list is 400
 * `INVALID_GRANTS`. Grants of the same resource are merged; grants without actions are dropped.
 */
export function checkGrants(
  catalog: AccessCatalog,
  input: unknown,
): AccessGrant[] {
  if (!Array.isArray(input)) malformed();
  const lookup = offered(catalog);
  const merged = new Map<string, Map<string, AccessGrantAction>>();
  const resources = new Map<string, AccessGrant['resource']>();
  for (const grant of input as unknown[]) {
    if (!isRecord(grant) || !isRecord(grant.resource)) malformed();
    const { type, id } = grant.resource;
    if (
      typeof type !== 'string' ||
      typeof id !== 'string' ||
      !Array.isArray(grant.actions)
    )
      malformed();
    const resourceKey = `${type}:${id}`;
    const actions = lookup.get(resourceKey);
    if (!actions) notAllowed(`${resourceKey} is not a NocoProject resource.`);
    const target =
      merged.get(resourceKey) ?? new Map<string, AccessGrantAction>();
    for (const entry of grant.actions as unknown[]) {
      if (!isRecord(entry) || typeof entry.action !== 'string') malformed();
      const scopes = actions.get(entry.action);
      if (!scopes) notAllowed(`${resourceKey} has no action ${entry.action}.`);
      const where = `${resourceKey}/${entry.action}`;
      const policy = checkPolicy(where, scopes, entry.policy);
      target.set(
        entry.action,
        policy ? { action: entry.action, policy } : { action: entry.action },
      );
    }
    merged.set(resourceKey, target);
    resources.set(resourceKey, { type, id });
  }
  return [...merged]
    .filter(([, actions]) => actions.size > 0)
    .map(([key, actions]) => ({
      resource: resources.get(key)!,
      actions: [...actions.values()],
    }));
}

/** A stored set's grants split into NocoProject's (`isNpResource`) and the platform's. */
export function splitGrants(grants: readonly AccessGrant[]): {
  readonly np: AccessGrant[];
  readonly foreign: AccessGrant[];
} {
  const np: AccessGrant[] = [];
  const foreign: AccessGrant[] = [];
  for (const grant of grants)
    (isNpResource(grant.resource) ? np : foreign).push(grant);
  return { np, foreign };
}
