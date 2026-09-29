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
  type DaemonCompatibility,
  type DaemonCompatibilityResponse,
  type DaemonCredential,
  type DaemonHeartbeatRequest,
  type DaemonHeartbeatRequestV2,
  type DaemonRegisterRequest,
  type DaemonRegisterRequestV2,
  type DaemonRegisterResponse,
  type Runtime,
} from '../shared/protocol.js';
import {
  daemonDeviceInfo,
  deviceNameOf,
  evaluateDaemon,
  markDaemonSeen,
  storedCredential,
  storedIdentity,
  type DaemonRow,
} from './daemon-compat.js';
import { isAgentProvider, mapRuntime } from './runtime.records.js';

export type RegisterRequest = DaemonRegisterRequest & DaemonRegisterRequestV2;
export type RegisterResponse = DaemonRegisterResponse &
  DaemonCompatibilityResponse;
export type HeartbeatRequest = DaemonHeartbeatRequest &
  DaemonHeartbeatRequestV2;
export interface HeartbeatResult {
  readonly count: number;
  readonly compatibility: DaemonCompatibility | null;
}

export const POLL_INTERVAL_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

export type RunAccess = 'ok' | 'notFound' | 'forbidden';

export interface RuntimeService {
  /** An unsupported daemon is registered too, with its runtimes `upgrade_required` (NP-150). */
  register(
    ownerUserId: string,
    request: RegisterRequest,
    credential?: DaemonCredential,
  ): Promise<RegisterResponse>;
  heartbeat(
    ownerUserId: string,
    request: HeartbeatRequest,
  ): Promise<HeartbeatResult>;
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

function validateRegister(request: RegisterRequest): void {
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
  request: RegisterRequest,
  credential: DaemonCredential | null,
): Promise<RegisterResponse> {
  validateRegister(request);
  const compatibility = evaluateDaemon(request);
  const deviceInfo = daemonDeviceInfo(request, compatibility, credential);
  const result = await deps.tx.run(async (tx) => {
    const registered: {
      id: string;
      provider: DaemonRegisterResponse['runtimes'][number]['provider'];
    }[] = [];
    const seen: DaemonRow[] = [];
    for (const runtime of request.runtimes) {
      const timestamp = now();
      const values = {
        name: `${request.deviceName || request.daemonId} (${runtime.provider})`,
        version:
          typeof runtime.version === 'string'
            ? runtime.version.slice(0, 64)
            : null,
        capabilities: toJson(runtime.capabilities ?? null),
        updatedAt: timestamp,
      };
      const existing = await tx.conn.query
        .selectFrom('runtimes')
        .select(['id', 'ownerUserId', 'status', 'deviceInfo'])
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
        const id = String(existing.id);
        registered.push({ id, provider: runtime.provider });
        seen.push({
          id,
          status: str(existing.status) ?? null,
          deviceInfo: existing.deviceInfo,
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
          status: 'offline',
          ...values,
        })
        .execute();
      registered.push({ id, provider: runtime.provider });
      seen.push({ id, status: 'offline' });
    }
    // The daemon's runtimes for tools it no longer registers (for example after a reinstall).
    const others = (
      await tx.conn.query
        .selectFrom('runtimes')
        .select(['id', 'status', 'deviceInfo'])
        .where('daemonId', '=', request.daemonId)
        .where('ownerUserId', '=', ownerUserId)
        .execute()
    )
      .filter((row) => !seen.some((item) => item.id === String(row.id)))
      .map((row) => ({
        id: String(row.id),
        status: str(row.status) ?? null,
        deviceInfo: row.deviceInfo,
      }));
    await markDaemonSeen(tx, {
      ownerUserId,
      daemonId: request.daemonId,
      deviceName: str(request.deviceName) ?? null,
      rows: seen,
      others,
      compatibility,
      deviceInfo,
    });
    tx.emit({ type: 'agents.changed' });
    return registered;
  });
  return {
    runtimes: result,
    serverTime: new Date().toISOString(),
    // The protocol both sides agreed on: a daemon checks this against what it speaks.
    protocolVersion: compatibility.negotiatedProtocol ?? PROTOCOL_VERSION,
    pollIntervalMs: POLL_INTERVAL_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    compatibility,
  };
}

async function heartbeat(
  deps: RuntimeDeps,
  ownerUserId: string,
  request: HeartbeatRequest,
): Promise<HeartbeatResult> {
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
      .select(['id', 'status', 'deviceInfo'])
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
    if (before.length === 0) return { count: 0, compatibility: null };
    // A protocol 2 daemon repeats its identity, so a server upgraded since register re-evaluates it at once.
    const reported = request.version !== undefined;
    const stored = storedIdentity(before[0]?.deviceInfo);
    const identity = reported
      ? {
          version: request.version,
          protocolVersion: request.protocolVersion,
          minProtocolVersion: request.minProtocolVersion,
        }
      : stored;
    const compatibility = evaluateDaemon(identity);
    const deviceName = deviceNameOf(before[0]?.deviceInfo);
    await markDaemonSeen(tx, {
      ownerUserId,
      daemonId: request.daemonId,
      deviceName,
      rows: before.map((row) => ({
        id: String(row.id as string),
        status: str(row.status) ?? null,
      })),
      compatibility,
      deviceInfo: reported
        ? daemonDeviceInfo(
            { ...identity, deviceName },
            compatibility,
            storedCredential(before[0]?.deviceInfo),
          )
        : undefined,
    });
    return { count: before.length, compatibility };
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
    register: (ownerUserId, request, credential) =>
      registerRuntimes(deps, ownerUserId, request, credential ?? null),
    heartbeat: (ownerUserId, request) => heartbeat(deps, ownerUserId, request),
    deregister: (ownerUserId, daemonId) =>
      deregister(deps, ownerUserId, daemonId),
    list: () => listRuntimes(deps),
    setVisibility: (actor, runtimeId, visibility) =>
      setVisibility(deps, actor, runtimeId, visibility),
    runAccess: (runId, userId) => runAccess(deps, runId, userId),
  };
}
