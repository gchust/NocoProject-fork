/**
 * Runtimes: one row per (daemon, provider). The daemon registers with its owner's API key, heartbeats every 15s, and
 * the sweeper marks silent runtimes offline.
 */
import type { Actor } from '../shared/activity.js';
import { forbid } from '../shared/authz.js';
import type { TxRunner } from '../shared/db.js';
import { isArrayValue, now, str, toJson } from '../shared/db.js';
import {
  invalid,
  notFound,
  NpError,
  runtimeNotFound,
} from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type { UserDirectory } from '../shared/users.js';
import {
  PROTOCOL_VERSION,
  type DaemonHeartbeatRequest,
  type DaemonRegisterRequest,
  type DaemonRegisterResponse,
  type Runtime,
} from '../shared/protocol.js';
import { isAgentProvider, mapRuntime } from './runtime.records.js';

export const POLL_INTERVAL_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

export type RunAccess = 'ok' | 'notFound' | 'forbidden';

export interface RuntimeService {
  register(
    ownerUserId: string,
    request: DaemonRegisterRequest,
  ): Promise<DaemonRegisterResponse>;
  heartbeat(
    ownerUserId: string,
    request: DaemonHeartbeatRequest,
  ): Promise<number>;
  deregister(ownerUserId: string, daemonId: string): Promise<number>;
  list(): Promise<Runtime[]>;
  /** Only the runtime owner may change its visibility (contract §B). */
  setVisibility(
    actor: Actor,
    runtimeId: string,
    visibility: unknown,
  ): Promise<Runtime>;
  /** Whether a daemon authenticated as `userId` may act on `runId` (it must own the run's runtime). */
  runAccess(runId: string, userId: string): Promise<RunAccess>;
}

function validateRegister(request: DaemonRegisterRequest): void {
  if (
    !request ||
    typeof request.daemonId !== 'string' ||
    request.daemonId.trim() === '' ||
    request.daemonId.length > 128
  ) {
    throw invalid(
      'INVALID_REGISTER',
      'daemonId is required (at most 128 characters).',
    );
  }
  if (
    request.protocolVersion !== undefined &&
    request.protocolVersion !== PROTOCOL_VERSION
  ) {
    throw new NpError(
      'upgradeRequired',
      'PROTOCOL_MISMATCH',
      `Server speaks protocol ${PROTOCOL_VERSION}; daemon sent ${String(request.protocolVersion)}.`,
    );
  }
  if (!isArrayValue(request.runtimes))
    throw invalid('INVALID_REGISTER', 'runtimes must be an array.');
  for (const runtime of request.runtimes) {
    if (!isAgentProvider(runtime?.provider)) {
      throw invalid(
        'INVALID_REGISTER',
        `Unknown provider "${String(runtime?.provider)}".`,
      );
    }
  }
}

export interface RuntimeDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
}

async function registerRuntimes(
  deps: RuntimeDeps,
  ownerUserId: string,
  request: DaemonRegisterRequest,
): Promise<DaemonRegisterResponse> {
  validateRegister(request);
  const result = await deps.tx.run(async (tx) => {
    const registered: {
      id: string;
      provider: DaemonRegisterResponse['runtimes'][number]['provider'];
    }[] = [];
    for (const runtime of request.runtimes) {
      const timestamp = now();
      const values = {
        name: `${request.deviceName || request.daemonId} (${runtime.provider})`,
        version:
          typeof runtime.version === 'string'
            ? runtime.version.slice(0, 64)
            : null,
        capabilities: toJson(runtime.capabilities ?? null),
        deviceInfo: toJson({
          deviceName: request.deviceName ?? null,
          daemonVersion: request.version ?? null,
        }),
        status: 'online',
        lastSeenAt: timestamp,
        updatedAt: timestamp,
      };
      const existing = await tx.conn.query
        .selectFrom('runtimes')
        .select(['id', 'ownerUserId'])
        .where('daemonId', '=', request.daemonId)
        .where('provider', '=', runtime.provider)
        .executeTakeFirst();
      if (existing) {
        if (existing.ownerUserId !== ownerUserId) {
          throw new NpError(
            'forbidden',
            'RUNTIME_NOT_OWNED',
            'This daemon id is registered to another user.',
          );
        }
        await tx.conn.query
          .updateTable('runtimes')
          .set(values)
          .where('id', '=', existing.id)
          .execute();
        registered.push({
          id: String(existing.id),
          provider: runtime.provider,
        });
        continue;
      }
      const id = deps.ids.next();
      await tx.conn.query
        .insertInto('runtimes')
        .values({
          id,
          daemonId: request.daemonId,
          provider: runtime.provider,
          kind: 'personal',
          ownerUserId,
          visibility: 'private',
          createdAt: timestamp,
          ...values,
        })
        .execute();
      registered.push({ id, provider: runtime.provider });
    }
    tx.emit({ type: 'agents.changed' });
    return registered;
  });
  return {
    runtimes: result,
    serverTime: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    pollIntervalMs: POLL_INTERVAL_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

async function heartbeat(
  deps: RuntimeDeps,
  ownerUserId: string,
  request: DaemonHeartbeatRequest,
): Promise<number> {
  if (
    !request ||
    typeof request.daemonId !== 'string' ||
    !isArrayValue(request.runtimeIds)
  ) {
    throw invalid('INVALID_HEARTBEAT', 'daemonId and runtimeIds are required.');
  }
  return deps.tx.run(async (tx) => {
    const known = await tx.conn.query
      .selectFrom('runtimes')
      .select(['id', 'status'])
      .where('ownerUserId', '=', ownerUserId)
      .where('daemonId', '=', request.daemonId)
      .execute();
    // Any runtime the daemon believes in but the server does not know makes it register again.
    const knownIds = new Set(known.map((row) => String(row.id as string)));
    if (known.length === 0) throw runtimeNotFound(request.daemonId);
    const missing = request.runtimeIds.find((id) => !knownIds.has(id));
    if (missing !== undefined) throw runtimeNotFound(missing);
    const before = known.filter((row) =>
      request.runtimeIds.includes(String(row.id as string)),
    );
    if (before.length === 0) return 0;
    const timestamp = now();
    await tx.conn.query
      .updateTable('runtimes')
      .set({
        status: 'online',
        lastSeenAt: timestamp,
        updatedAt: timestamp,
      })
      .where(
        'id',
        'in',
        before.map((row) => String(row.id as string)),
      )
      .execute();
    if (before.some((row) => row.status !== 'online'))
      tx.emit({ type: 'agents.changed' });
    return before.length;
  });
}

async function deregister(
  deps: RuntimeDeps,
  ownerUserId: string,
  daemonId: string,
): Promise<number> {
  if (typeof daemonId !== 'string' || daemonId === '')
    throw invalid('INVALID_DEREGISTER', 'daemonId is required.');
  return deps.tx.run(async (tx) => {
    const result = await tx.conn.query
      .updateTable('runtimes')
      .set({ status: 'offline', updatedAt: now() })
      .where('daemonId', '=', daemonId)
      .where('ownerUserId', '=', ownerUserId)
      .execute();
    tx.emit({ type: 'agents.changed' });
    return result.updatedCount ?? 0;
  });
}

async function listRuntimes(deps: RuntimeDeps): Promise<Runtime[]> {
  const conn = deps.tx.read();
  const runtimes = (
    await conn.query
      .selectFrom('runtimes')
      .selectAll()
      .orderBy('name', 'asc')
      .execute()
  ).map(mapRuntime);
  const owners = await deps.users.names(
    conn,
    runtimes.map((runtime) => runtime.ownerUserId),
  );
  return runtimes.map((runtime) => ({
    ...runtime,
    ownerName: owners.get(runtime.ownerUserId) ?? null,
  }));
}

async function setVisibility(
  deps: RuntimeDeps,
  actor: Actor,
  runtimeId: string,
  visibility: unknown,
): Promise<Runtime> {
  if (visibility !== 'private' && visibility !== 'public')
    throw invalid(
      'INVALID_VISIBILITY',
      'visibility must be private or public.',
    );
  await deps.tx.run(async (tx) => {
    const row = await tx.conn.query
      .selectFrom('runtimes')
      .select(['id', 'ownerUserId'])
      .where('id', '=', runtimeId)
      .executeTakeFirst();
    if (!row) throw notFound('Runtime');
    if (row.ownerUserId !== actor.id)
      forbid('Only the runtime owner may change its visibility.');
    await tx.conn.query
      .updateTable('runtimes')
      .set({ visibility, updatedAt: now() })
      .where('id', '=', runtimeId)
      .execute();
    tx.emit({ type: 'agents.changed' });
  });
  const runtime = (await listRuntimes(deps)).find(
    (item) => item.id === runtimeId,
  );
  if (!runtime) throw notFound('Runtime');
  return runtime;
}

async function runAccess(
  deps: RuntimeDeps,
  runId: string,
  userId: string,
): Promise<RunAccess> {
  const conn = deps.tx.read();
  const run = await conn.query
    .selectFrom('runs')
    .select(['runtimeId'])
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!run) return 'notFound';
  const runtimeId = str(run.runtimeId);
  if (!runtimeId) return 'forbidden';
  const runtime = await conn.query
    .selectFrom('runtimes')
    .select('ownerUserId')
    .where('id', '=', runtimeId)
    .executeTakeFirst();
  return runtime && runtime.ownerUserId === userId ? 'ok' : 'forbidden';
}

export function createRuntimeService(deps: RuntimeDeps): RuntimeService {
  return {
    register: (ownerUserId, request) =>
      registerRuntimes(deps, ownerUserId, request),
    heartbeat: (ownerUserId, request) => heartbeat(deps, ownerUserId, request),
    deregister: (ownerUserId, daemonId) =>
      deregister(deps, ownerUserId, daemonId),
    list: () => listRuntimes(deps),
    setVisibility: (actor, runtimeId, visibility) =>
      setVisibility(deps, actor, runtimeId, visibility),
    runAccess: (runId, userId) => runAccess(deps, runId, userId),
  };
}
