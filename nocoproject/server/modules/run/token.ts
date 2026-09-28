import { requireCapability } from '../agent/capabilities.js';
import { routeCapability } from './agent-capability-routes.js';
import { forbidden } from '../shared/errors.js';
/**
 * Run tokens (protocol.md §0): minted at claim inside the claim transaction, stored as a SHA-256 hash, valid until
 * revoked, expired (24h) or the run reaches a terminal status.
 */
import type { Conn, TxRunner } from '../shared/db.js';
import { addSeconds, now, str, toDate } from '../shared/db.js';
import type { IdSource } from '../shared/ids.js';
import { hashRunToken, mintRunToken } from '../shared/ids.js';
import { RUN_TOKEN_PREFIX, RUN_TOKEN_TTL_SECONDS } from '../shared/protocol.js';
import { findRun, isTerminalRunStatus } from './run.records.js';

/** What a valid run token resolves to. */
export interface RunAuth {
  readonly runId: string;
  readonly agentId: string;
  readonly actorUserId: string | null;
  readonly issueId: string;
}

export interface RunTokenService {
  authorize(auth: RunAuth, method: string, path: string): Promise<void>;
  verify(token: string): Promise<RunAuth | null>;
}

export async function issueRunToken(
  conn: Conn,
  ids: IdSource,
  run: { id: string; agentId: string; actorUserId: string | null },
): Promise<string> {
  const { token, hash } = mintRunToken();
  const createdAt = now();
  await conn.query
    .insertInto('runTokens')
    .values({
      id: ids.next(),
      hash,
      runId: run.id,
      agentId: run.agentId,
      actorUserId: run.actorUserId,
      expiresAt: addSeconds(createdAt, RUN_TOKEN_TTL_SECONDS),
      revokedAt: null,
      createdAt,
    })
    .execute();
  return token;
}

export function createRunTokenService(deps: { tx: TxRunner }): RunTokenService {
  return {
    async authorize(auth, method, path) {
      const capability = routeCapability(method, path);
      if (!capability)
        throw forbidden(
          'CAPABILITY_DENIED',
          'This agent endpoint has no capability assignment.',
        );
      await requireCapability(deps.tx.read(), auth, capability);
    },
    async verify(token) {
      if (!token.startsWith(RUN_TOKEN_PREFIX)) return null;
      const conn = deps.tx.read();
      const row = await conn.query
        .selectFrom('runTokens')
        .select(['runId', 'agentId', 'actorUserId', 'expiresAt', 'revokedAt'])
        .where('hash', '=', hashRunToken(token))
        .executeTakeFirst();
      if (!row || (row.revokedAt ?? null) !== null) return null;
      const expiresAt = toDate(row.expiresAt);
      if (!expiresAt || expiresAt.getTime() <= Date.now()) return null;
      const run = await findRun(conn, str(row.runId) ?? '');
      if (!run || isTerminalRunStatus(run.status)) return null;
      return {
        runId: run.id,
        agentId: str(row.agentId) ?? run.agentId,
        actorUserId: str(row.actorUserId),
        issueId: run.subjectId,
      };
    },
  };
}
