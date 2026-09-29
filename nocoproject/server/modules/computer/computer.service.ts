/**
 * Computer credentials (NP-150, `protocol.computers-server.ts`). Adding a computer issues an API key of the
 * non-session `np-computer` configuration (through `ComputerKeys`, backed by the API Keys plugin's `ApiKeyService`);
 * the daemon guard (`server/routes/np-daemon.ts`) authenticates `/np/daemon/*` with it and binds it to the daemon id
 * of the computer's first register. Revoking disables the key, marks the row and takes the computer's runtimes
 * offline, in one transaction.
 *
 * Only the owner lists, names and revokes their computers; whoever holds `agents/manage` on every agent (NP-153: the
 * computers run the agents' runtimes) sees and revokes everyone's.
 */
import { createHash } from 'node:crypto';

import type { Actor } from '../shared/activity.js';
import { NP_BUSINESS } from '../shared/access.js';
import { forbid, scopeIn, viewerOf } from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { iso, isoOrNull, now, str, toDate } from '../shared/db.js';
import { invalid, notFound, NpError } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  CreateComputerRequest,
  CreateComputerResponse,
  NpComputer,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { deviceNameOf } from '../runtime/daemon-compat.js';

/** The credential store: the API Keys plugin's `np-computer` configuration (a double in tests). */
export interface ComputerKeys {
  create(
    conn: Conn,
    input: { readonly userId: string; readonly name: string },
  ): Promise<{ keyId: string; keyStart: string | null; secret: string }>;
  /** The key id and owner of a valid, enabled key; null otherwise. */
  verify(secret: string): Promise<{ keyId: string; userId: string } | null>;
  disable(conn: Conn, keyId: string): Promise<void>;
}

/** Who a computer credential authenticates. */
export interface ComputerCaller {
  readonly computerId: string;
  readonly ownerUserId: string;
  readonly daemonId: string | null;
}

export interface ComputerService {
  create(
    actor: Actor,
    request: CreateComputerRequest,
  ): Promise<CreateComputerResponse>;
  list(actor: Actor): Promise<NpComputer[]>;
  revoke(actor: Actor, id: string): Promise<NpComputer>;
  /** 401 `COMPUTER_KEY_INVALID` / `COMPUTER_REVOKED` / `COMPUTER_OWNER_DISABLED`. */
  authenticate(secret: string): Promise<ComputerCaller>;
  /** Binds the credential to `daemonId` at its first use; 403 `COMPUTER_DAEMON_MISMATCH` for any other daemon. */
  bindDaemon(caller: ComputerCaller, daemonId: string): Promise<void>;
  /** 403 `COMPUTER_DAEMON_MISMATCH` unless the run's runtime belongs to the caller's daemon. */
  requireRun(caller: ComputerCaller, runId: string): Promise<void>;
}

export interface ComputerDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly keys: ComputerKeys;
}

const NAME_MAX = 255;
/** `lastUsedAt` is written at most this often per computer. */
const LAST_USED_EVERY_MS = 60_000;

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function unauthorized(code: string, message: string): NpError {
  return new NpError('unauthorized', code, message);
}

function mismatch(): NpError {
  return new NpError(
    'forbidden',
    'COMPUTER_DAEMON_MISMATCH',
    'This computer credential belongs to another daemon.',
  );
}

function computerName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw invalid('INVALID_NAME', 'name is required.');
  return value.trim().slice(0, NAME_MAX);
}

async function viewComputers(
  deps: ComputerDeps,
  conn: Conn,
  rows: readonly Record<string, unknown>[],
  viewer: { userId: string; admin: boolean },
): Promise<NpComputer[]> {
  const owners = await deps.users.names(
    conn,
    rows.map((row) => str(row.ownerUserId)),
  );
  const daemonIds = rows
    .map((row) => str(row.daemonId))
    .filter((id): id is string => !!id);
  const runtimes = daemonIds.length
    ? await conn.query
        .selectFrom('runtimes')
        .select(['daemonId', 'deviceInfo'])
        .where('daemonId', 'in', daemonIds)
        .execute()
    : [];
  return rows.map((row) => {
    const ownerUserId = str(row.ownerUserId) ?? '';
    const daemonId = str(row.daemonId) ?? null;
    const runtime = runtimes.find((item) => item.daemonId === daemonId);
    return {
      id: str(row.id) ?? '',
      ownerUserId,
      ownerName: owners.get(ownerUserId) ?? null,
      name: str(row.name) ?? '',
      keyStart: str(row.keyStart) ?? null,
      daemonId,
      deviceName: runtime ? deviceNameOf(runtime.deviceInfo) : null,
      lastUsedAt: isoOrNull(row.lastUsedAt),
      createdAt: iso(row.createdAt),
      revokedAt: isoOrNull(row.revokedAt),
      canRevoke:
        !row.revokedAt && (viewer.admin || viewer.userId === ownerUserId),
    };
  });
}

async function viewerFacts(
  deps: ComputerDeps,
  actor: Actor,
): Promise<{ userId: string; admin: boolean }> {
  // Before any transaction: an authorization check reads through the application's own connection.
  const viewer = await viewerOf(deps.tx.read(), actor);
  return {
    userId: viewer.userId,
    admin: scopeIn(viewer, NP_BUSINESS.agents, 'manage') === 'all',
  };
}

async function findComputer(
  conn: Conn,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  return conn.query
    .selectFrom('npComputers')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
}

export function createComputerService(deps: ComputerDeps): ComputerService {
  const one = async (
    conn: Conn,
    id: string,
    viewer: { userId: string; admin: boolean },
  ): Promise<NpComputer> => {
    const row = await findComputer(conn, id);
    if (!row) throw notFound('Computer');
    const [computer] = await viewComputers(deps, conn, [row], viewer);
    return computer;
  };

  return {
    async create(actor, request) {
      // A personal API key must not mint credentials (the same rule as `/api-key/create`, `server/auth/`).
      if (actor.via)
        throw new NpError(
          'forbidden',
          'COMPUTER_NEEDS_SIGN_IN',
          'Add a computer from the browser, signed in; an API key cannot issue computer credentials.',
        );
      const viewer = await viewerFacts(deps, actor);
      const name = computerName(request?.name);
      const { id, secret } = await deps.tx.run(async (tx) => {
        const key = await deps.keys.create(tx.conn, {
          userId: viewer.userId,
          name: `Computer: ${name}`.slice(0, NAME_MAX),
        });
        const computerId = deps.ids.next();
        await tx.conn.query
          .insertInto('npComputers')
          .values({
            id: computerId,
            ownerUserId: viewer.userId,
            name,
            keyId: key.keyId,
            keyStart: key.keyStart,
            keyHash: hashSecret(key.secret),
            daemonId: null,
            lastUsedAt: null,
            createdAt: now(),
            revokedAt: null,
            revokedById: null,
          })
          .execute();
        tx.emit({ type: 'agents.changed' });
        return { id: computerId, secret: key.secret };
      });
      return { computer: await one(deps.tx.read(), id, viewer), key: secret };
    },

    async list(actor) {
      const viewer = await viewerFacts(deps, actor);
      const conn = deps.tx.read();
      let select = conn.query
        .selectFrom('npComputers')
        .selectAll()
        .orderBy('createdAt', 'desc');
      if (!viewer.admin)
        select = select.where('ownerUserId', '=', viewer.userId);
      return viewComputers(deps, conn, await select.execute(), viewer);
    },

    async revoke(actor, id) {
      const viewer = await viewerFacts(deps, actor);
      await deps.tx.run(async (tx) => {
        const row = await findComputer(tx.conn, id);
        if (!row) throw notFound('Computer');
        if (!viewer.admin && row.ownerUserId !== viewer.userId)
          forbid('Only the computer owner or an admin may revoke it.');
        if (row.revokedAt) return;
        await deps.keys.disable(tx.conn, str(row.keyId) ?? '');
        const timestamp = now();
        await tx.conn.query
          .updateTable('npComputers')
          .set({ revokedAt: timestamp, revokedById: viewer.userId })
          .where('id', '=', id)
          .execute();
        const daemonId = str(row.daemonId);
        if (daemonId) {
          await tx.conn.query
            .updateTable('runtimes')
            .set({ status: 'offline', updatedAt: timestamp })
            .where('daemonId', '=', daemonId)
            .where('ownerUserId', '=', str(row.ownerUserId) ?? '')
            .execute();
        }
        tx.emit({ type: 'agents.changed' });
      });
      return one(deps.tx.read(), id, viewer);
    },

    async authenticate(secret) {
      if (
        typeof secret !== 'string' ||
        secret.length === 0 ||
        secret.length > 512
      )
        throw unauthorized(
          'COMPUTER_KEY_INVALID',
          'The computer credential is not valid.',
        );
      const key = await deps.keys.verify(secret);
      const conn = deps.tx.read();
      const row = await conn.query
        .selectFrom('npComputers')
        .selectAll()
        .where('keyHash', '=', hashSecret(secret))
        .executeTakeFirst();
      if (row?.revokedAt)
        throw unauthorized(
          'COMPUTER_REVOKED',
          'This computer credential was revoked; add the computer again.',
        );
      if (
        !key ||
        !row ||
        row.keyId !== key.keyId ||
        row.ownerUserId !== key.userId
      )
        throw unauthorized(
          'COMPUTER_KEY_INVALID',
          'The computer credential is not valid.',
        );
      const owner = await conn.query
        .selectFrom('user')
        .select(['disabledAt', 'deletedAt'])
        .where('id', '=', key.userId)
        .executeTakeFirst();
      if (!owner || owner.disabledAt || owner.deletedAt)
        throw unauthorized(
          'COMPUTER_OWNER_DISABLED',
          "The computer owner's account is disabled.",
        );
      const lastUsed = toDate(row.lastUsedAt);
      if (!lastUsed || Date.now() - lastUsed.getTime() > LAST_USED_EVERY_MS)
        await conn.query
          .updateTable('npComputers')
          .set({ lastUsedAt: now() })
          .where('id', '=', str(row.id) ?? '')
          .execute();
      return {
        computerId: str(row.id) ?? '',
        ownerUserId: key.userId,
        daemonId: str(row.daemonId) ?? null,
      };
    },

    async bindDaemon(caller, daemonId) {
      if (typeof daemonId !== 'string' || daemonId === '') return;
      if (caller.daemonId) {
        if (caller.daemonId !== daemonId) throw mismatch();
        return;
      }
      const conn = deps.tx.read();
      await conn.query
        .updateTable('npComputers')
        .set({ daemonId })
        .where('id', '=', caller.computerId)
        .where('daemonId', 'is', null)
        .execute();
      const row = await findComputer(conn, caller.computerId);
      // A concurrent first request may have bound it to another daemon.
      if (str(row?.daemonId) !== daemonId) throw mismatch();
    },

    async requireRun(caller, runId) {
      const conn = deps.tx.read();
      const run = await conn.query
        .selectFrom('runs')
        .select('runtimeId')
        .where('id', '=', runId)
        .executeTakeFirst();
      const runtimeId = str(run?.runtimeId);
      if (!runtimeId) return; // unknown runs are answered by the run routes (404)
      const runtime = await conn.query
        .selectFrom('runtimes')
        .select('daemonId')
        .where('id', '=', runtimeId)
        .executeTakeFirst();
      if (!caller.daemonId || runtime?.daemonId !== caller.daemonId)
        throw mismatch();
    },
  };
}
