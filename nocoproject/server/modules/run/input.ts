/** Durable run input and the completion fence. Input stays in runTriggers for retries. */
import type { Conn, Tx } from '../shared/db.js';
import { fromJson, isPostgres, knexOf } from '../shared/db.js';
import { conflict, invalid } from '../shared/errors.js';
import type { ClaimedTriggerComment } from '../shared/protocol.js';
import type { RunV1 } from './run.records.js';
import { mapRun } from './run.records.js';

/** Lock before appending input or completing, including a recheck after a competing writer. */
export async function lockRun(conn: Conn, runId: string): Promise<void> {
  if (isPostgres(conn)) {
    const knex = await knexOf(conn);
    await knex('runs').select('id').where('id', runId).forUpdate();
  }
}

/** A unique current run in the same authorization context; never guess between concurrent agents. */
export async function currentInputRun(
  tx: Tx,
  subjectId: string,
  actorUserId: string | null,
  agentId?: string,
): Promise<RunV1 | null> {
  if (!actorUserId) return null;
  let query = tx.conn.query
    .selectFrom('runs')
    .selectAll()
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', subjectId)
    .where('actorUserId', '=', actorUserId)
    .where('status', '=', 'running')
    .where('acceptsInput', '=', true)
    .where('cancelRequestedAt', 'is', null);
  if (agentId) query = query.where('agentId', '=', agentId);
  const rows = await query.limit(2).execute();
  if (rows.length !== 1 || rows[0].threadScope === 'retro') return null;
  return mapRun(rows[0]);
}

export async function runInputs(
  conn: Conn,
  runId: string,
): Promise<ClaimedTriggerComment[]> {
  const rows = await conn.query
    .selectFrom('runTriggers')
    .select('payload')
    .where('runId', '=', runId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.flatMap((row) => {
    const payload = fromJson<{ input?: ClaimedTriggerComment }>(row.payload);
    return payload?.input ? [payload.input] : [];
  });
}

export async function requireHandledInputs(
  conn: Conn,
  runId: string,
  ids: readonly string[] = [],
): Promise<void> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
    throw invalid(
      'INVALID_INPUT_IDS',
      'handledInputIds must be an array of strings.',
    );
  const handled = new Set(ids);
  if (
    (await runInputs(conn, runId)).some((message) => !handled.has(message.id))
  ) {
    throw conflict(
      'RUN_INPUT_PENDING',
      'New comments must be processed before completing this run.',
    );
  }
}

/** Capability is per run, never inferred from a runtime that may have been upgraded. */
export async function acceptsRunInput(
  conn: Conn,
  runId: string,
): Promise<boolean> {
  const row = await conn.query
    .selectFrom('runs')
    .select('acceptsInput')
    .where('id', '=', runId)
    .executeTakeFirst();
  return row?.acceptsInput === true || row?.acceptsInput === 1;
}
