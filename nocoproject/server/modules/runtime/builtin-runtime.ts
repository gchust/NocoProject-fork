/**
 * Built-in runtimes (NP-219, protocol-runtime-types.md §4): one `runtimes` row per LLM service of the AI plugin that an
 * owner / admin enabled (`nocoproject.general` `update`, the same setting as `pmAllowed`).
 *
 * - The row: `runtimeType = 'builtin'`, `provider = 'nocobase-ai'`, `kind = 'server'`, `llmService`, and the synthetic
 *   `daemonId = 'builtin:<llmService>'`, so the existing unique (daemonId, provider) pair enables a service only once.
 * - No heartbeat: `status` / `statusReason` are computed here (§4.2) on every list (configuration reasons only, no model
 *   call), on a connectivity check, at application start and around every built-in run. `check_failed` is only cleared
 *   by a successful check or run.
 * - The connectivity check is one tiny model call, so it only runs when an admin asks, when a service is enabled and
 *   at application start.
 */
import type { Actor } from '../shared/activity.js';
import { requireSetting } from '../shared/authz.js';
import { NP_SETTINGS } from '../shared/access.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { isUniqueViolation, now, str } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import {
  BUILTIN_PROVIDER,
  type BuiltinCandidates,
  type BuiltinStatusReason,
  type EnableBuiltinRuntimeRequest,
} from '../shared/protocol.js';
import { requiredName } from '../shared/validate.js';
import {
  usableService,
  type BuiltinAiSource,
  type BuiltinCatalog,
} from './builtin-ai.js';
import {
  mapRuntime,
  statusReasonOf,
  type RuntimeView,
} from './runtime.records.js';

/** `daemonId` (128) holds `builtin:` and the service name. */
const LLM_SERVICE_MAX = 120;
const DAEMON_PREFIX = 'builtin:';
const MANAGE_MESSAGE = 'Only an owner or admin may manage built-in runtimes.';

export interface BuiltinRuntimeDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly ai: BuiltinAiSource;
}

export interface BuiltinState {
  readonly status: 'online' | 'offline';
  readonly statusReason: BuiltinStatusReason | null;
}

export interface BuiltinCheck {
  readonly runtime: RuntimeView;
  /** Why the check failed; null when it passed. */
  readonly message: string | null;
}

/** §4.2: the configuration reasons first, then a sticky `check_failed`, else online. */
export function builtinState(
  row: { readonly llmService?: unknown; readonly statusReason?: unknown },
  catalog: BuiltinCatalog | null,
): BuiltinState {
  const reason = configurationReason(str(row.llmService), catalog);
  if (reason) return { status: 'offline', statusReason: reason };
  return statusReasonOf(row.statusReason) === 'check_failed'
    ? { status: 'offline', statusReason: 'check_failed' }
    : { status: 'online', statusReason: null };
}

function configurationReason(
  llmService: string | null,
  catalog: BuiltinCatalog | null,
): BuiltinStatusReason | null {
  if (!catalog) return 'plugin_missing';
  if (!catalog.services.some((service) => service.name === llmService))
    return 'service_removed';
  if (!usableService(catalog, llmService)) return 'no_enabled_model';
  return null;
}

/** The plugin's catalog, or null when the plugin is missing or cannot answer. */
export async function loadCatalog(
  ai: BuiltinAiSource,
): Promise<BuiltinCatalog | null> {
  const source = ai();
  if (!source) return null;
  try {
    return await source.catalog();
  } catch {
    return null;
  }
}

async function builtinRows(conn: Conn, id?: string) {
  const query = conn.query
    .selectFrom('runtimes')
    .selectAll()
    .where('runtimeType', '=', 'builtin');
  return (id ? query.where('id', '=', id) : query).execute();
}

/** Writes the computed state of every built-in runtime whose stored state differs; true when any changed. */
export async function refreshBuiltinRuntimes(
  deps: BuiltinRuntimeDeps,
  catalog: BuiltinCatalog | null,
): Promise<boolean> {
  const rows = await builtinRows(deps.tx.read());
  const changed = rows.filter((row) => {
    const state = builtinState(row, catalog);
    return (
      state.status !== row.status ||
      state.statusReason !== statusReasonOf(row.statusReason)
    );
  });
  if (changed.length === 0) return false;
  await deps.tx.run(async (tx) => {
    for (const row of changed)
      await tx.conn.query
        .updateTable('runtimes')
        .set({ ...builtinState(row, catalog), updatedAt: now() })
        .where('id', '=', String(row.id))
        .execute();
    tx.emit({ type: 'agents.changed' });
  });
  return true;
}

/** Adds the catalog's title and enabled models to built-in rows. */
export function withCatalog<T extends RuntimeView>(
  runtime: T,
  catalog: BuiltinCatalog | null,
): T {
  if (runtime.runtimeType !== 'builtin' || !catalog) return runtime;
  const service = catalog.enabled.find(
    (item) => item.llmService === runtime.llmService,
  );
  const configured = catalog.services.find(
    (item) => item.name === runtime.llmService,
  );
  return {
    ...runtime,
    llmServiceTitle: service?.title ?? configured?.title ?? null,
    enabledModels: service?.enabledModels ?? [],
  };
}

export async function builtinCandidates(
  deps: BuiltinRuntimeDeps,
  actor: Actor,
): Promise<BuiltinCandidates> {
  const conn = deps.tx.read();
  await requireSetting(
    conn,
    actor,
    NP_SETTINGS.general,
    'update',
    MANAGE_MESSAGE,
  );
  const catalog = deps.ai() ? await loadCatalog(deps.ai) : null;
  if (!catalog) return { plugin: 'missing', services: [] };
  const enabled = new Map(
    (await builtinRows(conn)).map((row) => [
      str(row.llmService),
      String(row.id),
    ]),
  );
  return {
    plugin: 'ready',
    services: catalog.enabled
      .filter((service) => service.enabledModels.length > 0)
      .map((service) => ({
        llmService: service.llmService,
        title: service.title,
        provider: service.provider,
        enabledModels: service.enabledModels,
        runtimeId: enabled.get(service.llmService) ?? null,
      })),
  };
}

/** `POST /np/runtimes/builtin`: the new row, then a first connectivity check. */
export async function enableBuiltinRuntime(
  deps: BuiltinRuntimeDeps,
  actor: Actor,
  input: EnableBuiltinRuntimeRequest,
): Promise<BuiltinCheck> {
  await requireSetting(
    deps.tx.read(),
    actor,
    NP_SETTINGS.general,
    'update',
    MANAGE_MESSAGE,
  );
  const catalog = deps.ai() ? await loadCatalog(deps.ai) : null;
  if (!catalog)
    throw invalid(
      'BUILTIN_RUNTIME_UNAVAILABLE',
      'The AI plugin is not enabled, so built-in runtimes are unavailable.',
    );
  const llmService =
    typeof input?.llmService === 'string' ? input.llmService : '';
  const service =
    llmService.length <= LLM_SERVICE_MAX
      ? usableService(catalog, llmService)
      : null;
  if (!service)
    throw invalid(
      'INVALID_LLM_SERVICE',
      'llmService is not an enabled LLM service with an enabled model.',
    );
  const id = deps.ids.next();
  try {
    await deps.tx.run(async (tx) => {
      const existing = await tx.conn.query
        .selectFrom('runtimes')
        .select('id')
        .where('daemonId', '=', `${DAEMON_PREFIX}${llmService}`)
        .where('provider', '=', BUILTIN_PROVIDER)
        .executeTakeFirst();
      if (existing) throw runtimeExists(String(existing.id));
      const timestamp = now();
      await tx.conn.query
        .insertInto('runtimes')
        .values({
          id,
          daemonId: `${DAEMON_PREFIX}${llmService}`,
          provider: BUILTIN_PROVIDER,
          runtimeType: 'builtin',
          llmService,
          name: service.title.slice(0, 255) || llmService,
          kind: 'server',
          ownerUserId: actor.id,
          visibility: 'public',
          pmAllowed: false,
          status: 'offline',
          statusReason: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute();
      tx.emit({ type: 'agents.changed' });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw runtimeExists(null);
    throw error;
  }
  return checkRow(deps, id);
}

function runtimeExists(runtimeId: string | null) {
  return conflict(
    'RUNTIME_EXISTS',
    'This LLM service is already enabled as a built-in runtime.',
    runtimeId ? { runtimeId } : undefined,
  );
}

async function requireBuiltin(conn: Conn, id: string) {
  const row = await conn.query
    .selectFrom('runtimes')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Runtime');
  if (row.runtimeType !== 'builtin')
    throw invalid('INVALID_RUNTIME', 'This is not a built-in runtime.');
  return row;
}

/** `POST /np/runtimes/:id/check` */
export async function checkBuiltinRuntime(
  deps: BuiltinRuntimeDeps,
  actor: Actor,
  id: string,
): Promise<BuiltinCheck> {
  await requireSetting(
    deps.tx.read(),
    actor,
    NP_SETTINGS.general,
    'update',
    MANAGE_MESSAGE,
  );
  await requireBuiltin(deps.tx.read(), id);
  return checkRow(deps, id);
}

/** Checks every built-in runtime (application start); failures only show in their status. */
export async function checkAllBuiltinRuntimes(
  deps: BuiltinRuntimeDeps,
): Promise<void> {
  for (const row of await builtinRows(deps.tx.read()))
    await checkRow(deps, String(row.id));
}

async function checkRow(
  deps: BuiltinRuntimeDeps,
  id: string,
): Promise<BuiltinCheck> {
  const catalog = deps.ai() ? await loadCatalog(deps.ai) : null;
  const row = await requireBuiltin(deps.tx.read(), id);
  const llmService = str(row.llmService);
  const reason = configurationReason(llmService, catalog);
  const service = catalog ? usableService(catalog, llmService) : null;
  const source = deps.ai();
  const result =
    reason || !service || !source
      ? { ok: false, message: reason ?? 'plugin_missing' }
      : await source
          .testFlight(service.llmService, service.enabledModels[0].value)
          .catch((error: unknown) => ({
            ok: false,
            message: String((error as Error)?.message ?? error),
          }));
  const timestamp = now();
  await deps.tx.run(async (tx) => {
    await tx.conn.query
      .updateTable('runtimes')
      .set({
        status: result.ok ? 'online' : 'offline',
        statusReason: result.ok ? null : (reason ?? 'check_failed'),
        lastCheckedAt: timestamp,
        ...(result.ok ? { lastSeenAt: timestamp } : {}),
        updatedAt: timestamp,
      })
      .where('id', '=', id)
      .execute();
    tx.emit({ type: 'agents.changed' });
  });
  const fresh = await requireBuiltin(deps.tx.read(), id);
  return {
    runtime: withCatalog(mapRuntime(fresh), catalog),
    message: result.ok ? null : (result.message ?? '').slice(0, 500) || null,
  };
}

/** `DELETE /np/runtimes/:id`: only a built-in runtime no agent (archived included, deleted excluded) refers to. */
export async function removeBuiltinRuntime(
  deps: BuiltinRuntimeDeps,
  actor: Actor,
  id: string,
): Promise<void> {
  await requireSetting(
    deps.tx.read(),
    actor,
    NP_SETTINGS.general,
    'update',
    MANAGE_MESSAGE,
  );
  await deps.tx.run(async (tx) => {
    await requireBuiltin(tx.conn, id);
    const agents = await tx.conn.query
      .selectFrom('agents')
      .select('id')
      .where('runtimeId', '=', id)
      .where('deletedAt', 'is', null)
      .execute();
    if (agents.length > 0)
      throw conflict(
        'RUNTIME_IN_USE',
        'Agents still use this built-in runtime; move or delete them first.',
        { agentIds: agents.map((row) => String(row.id)) },
      );
    // Past runs keep their runtimeId and runtimeType.
    await tx.conn.query.deleteFrom('runtimes').where('id', '=', id).execute();
    tx.emit({ type: 'agents.changed' });
  });
}

/** `PATCH /np/runtimes/:id { name }`: built-in only (a computer runtime's name comes from its daemon). */
export async function renameBuiltinRuntime(
  deps: BuiltinRuntimeDeps,
  actor: Actor,
  id: string,
  name: unknown,
): Promise<void> {
  const row = await deps.tx
    .read()
    .query.selectFrom('runtimes')
    .select(['id', 'runtimeType'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Runtime');
  if (row.runtimeType !== 'builtin')
    throw invalid(
      'INVALID_RUNTIME',
      'A computer runtime is named by its daemon.',
    );
  await requireSetting(
    deps.tx.read(),
    actor,
    NP_SETTINGS.general,
    'update',
    MANAGE_MESSAGE,
  );
  const value = requiredName(name);
  await deps.tx.run(async (tx) => {
    await tx.conn.query
      .updateTable('runtimes')
      .set({ name: value, updatedAt: now() })
      .where('id', '=', id)
      .execute();
    tx.emit({ type: 'agents.changed' });
  });
}
