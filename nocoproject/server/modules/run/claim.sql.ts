/**
 * Claim SQL (PostgreSQL), verbatim from protocol.md §4 apart from `updated_at` and bound parameters.
 *
 * Bindings: [runtimeId (SET runtime_id), runtimeId (a.runtime_id), whether the daemon may take project manager
 * conversation runs (NP-183: a daemon older than `PM_ASSISTANT_MIN_CLI` leaves them queued)].
 *
 * The NocoBase QueryAdapter has no `FOR UPDATE SKIP LOCKED` or `RETURNING`, so this runs through the transaction's
 * Knex client (`await connection.client()` inside `db.transaction()` is the Knex transaction itself).
 */
import { CLAIM_LEASE_SECONDS } from '../shared/protocol.js';

export const CLAIM_RUN_SQL = `
UPDATE runs
   SET status = 'dispatched',
       dispatched_at = now(),
       lease_expires_at = now() + interval '${CLAIM_LEASE_SECONDS} seconds',
       runtime_id = ?,
       updated_at = now()
 WHERE id = (
   SELECT r.id
     FROM runs r
     JOIN agents a ON a.id = r.agent_id
    WHERE r.status = 'queued'
      AND a.runtime_id = ?
      AND a.archived_at IS NULL
      AND (?::boolean OR NOT EXISTS (
        SELECT 1 FROM pm_conversations c WHERE c.issue_id = r.subject_id))
      AND NOT EXISTS (
        SELECT 1 FROM runs x
         WHERE x.agent_id = r.agent_id
           AND x.subject_type = r.subject_type
           AND x.subject_id = r.subject_id
           AND x.status IN ('dispatched', 'running'))
      AND (SELECT count(*) FROM runs y
            WHERE y.agent_id = r.agent_id
              AND y.status IN ('dispatched', 'running')) < a.max_concurrent_runs
    ORDER BY r.priority DESC, r.created_at ASC, r.id ASC
    FOR UPDATE OF r SKIP LOCKED
    LIMIT 1)
RETURNING id, agent_id, actor_user_id, subject_id`;

/**
 * Serializes claims per runtime for the rest of the transaction.
 *
 * `SKIP LOCKED` alone is not enough for the protocol's two per-agent rules: two concurrent claimers can each lock a
 * different queued run of the same agent, and neither sees the other's uncommitted `dispatched` row when evaluating
 * the NOT EXISTS / count(*) subqueries (READ COMMITTED). An agent's runs are only ever claimed for its own runtime
 * (`a.runtime_id = ?`), so one transaction-scoped advisory lock per runtime closes that race while claims for
 * different runtimes still proceed in parallel.
 */
export const CLAIM_RUNTIME_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtext(?))';

export function claimLockKey(runtimeId: string): string {
  return `np:claim:${runtimeId}`;
}

export interface ClaimedRow {
  readonly id: string;
  readonly agent_id: string;
  readonly actor_user_id: string | null;
  readonly subject_id: string;
}
