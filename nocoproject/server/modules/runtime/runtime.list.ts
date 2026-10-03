/**
 * `GET /np/runtimes` rows (`RuntimeView`): both types or one, with owner names; built-in rows are recomputed from the
 * AI plugin's catalog first and carry its title and enabled models (NP-219, `builtin-runtime.ts`). Split out of
 * `runtime.service.ts` to keep it within the file size limit.
 */
import { notFound } from '../shared/errors.js';
import type { RuntimeType } from '../shared/protocol.js';
import { noBuiltinAi } from './builtin-ai.js';
import {
  loadCatalog,
  refreshBuiltinRuntimes,
  withCatalog,
} from './builtin-runtime.js';
import { mapRuntime, type RuntimeView } from './runtime.records.js';
import type { RuntimeDeps } from './runtime.service.js';

export function builtinDeps(deps: RuntimeDeps) {
  return { tx: deps.tx, ids: deps.ids, ai: deps.ai ?? noBuiltinAi };
}

export async function listRuntimes(
  deps: RuntimeDeps,
  runtimeType: RuntimeType | null = null,
): Promise<RuntimeView[]> {
  const builtin = builtinDeps(deps);
  const catalog =
    runtimeType === 'computer' ? null : await loadCatalog(builtin.ai);
  if (runtimeType !== 'computer')
    await refreshBuiltinRuntimes(builtin, catalog);
  const conn = deps.tx.read();
  const query = conn.query.selectFrom('runtimes').selectAll();
  const runtimes = (
    await (runtimeType ? query.where('runtimeType', '=', runtimeType) : query)
      .orderBy('name', 'asc')
      .execute()
  ).map((row) => withCatalog(mapRuntime(row), catalog));
  const owners = await deps.users.names(
    conn,
    runtimes.map((runtime) => runtime.ownerUserId),
  );
  return runtimes.map((runtime) => ({
    ...runtime,
    ownerName: owners.get(runtime.ownerUserId) ?? null,
  }));
}

export async function findView(
  deps: RuntimeDeps,
  runtimeId: string,
): Promise<RuntimeView> {
  const runtime = (await listRuntimes(deps)).find(
    (item) => item.id === runtimeId,
  );
  if (!runtime) throw notFound('Runtime');
  return runtime;
}
