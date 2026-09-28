/**
 * `runSessions`: the provider session an agent last used on a subject from a runtime, so the next run can resume
 * it (or must start fresh when it is poisoned).
 */
import type { Conn } from '../shared/db.js';
import { bool, str } from '../shared/db.js';
import type { IdSource } from '../shared/ids.js';
import type { Run } from '../shared/protocol.js';

export interface SessionUpdate {
  readonly providerSessionId?: string | null;
  readonly workDir?: string | null;
  readonly poisoned: boolean;
  /** Checkout reported by the daemon (iteration 1); left unchanged when absent. */
  readonly branchName?: string | null;
  readonly repoUrl?: string | null;
}

export interface StoredSession {
  readonly providerSessionId: string | null;
  readonly workDir: string | null;
  readonly poisoned: boolean;
  readonly branchName: string | null;
  readonly repoUrl: string | null;
}

export async function findSession(
  conn: Conn,
  key: {
    agentId: string;
    runtimeId: string;
    subjectType: string;
    subjectId: string;
  },
): Promise<StoredSession | null> {
  const row = await conn.query
    .selectFrom('runSessions')
    .select([
      'providerSessionId',
      'workDir',
      'poisoned',
      'branchName',
      'repoUrl',
    ])
    .where('agentId', '=', key.agentId)
    .where('runtimeId', '=', key.runtimeId)
    .where('subjectType', '=', key.subjectType)
    .where('subjectId', '=', key.subjectId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    providerSessionId: str(row.providerSessionId),
    workDir: str(row.workDir),
    poisoned: bool(row.poisoned),
    branchName: str(row.branchName),
    repoUrl: str(row.repoUrl),
  };
}

/**
 * Records the session a finished run used. Runs of one agent on one subject never execute concurrently (the claim
 * rule), so select-then-write inside the caller's transaction does not race in practice; the unique index is the
 * backstop.
 */
export async function upsertSession(
  conn: Conn,
  ids: IdSource,
  run: Run,
  update: SessionUpdate,
): Promise<void> {
  if (!run.runtimeId) return;
  const key = {
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    subjectType: run.subjectType,
    subjectId: run.subjectId,
  };
  const values: Record<string, unknown> = {
    poisoned: update.poisoned,
    lastRunId: run.id,
    updatedAt: new Date(),
  };
  if (update.providerSessionId !== undefined)
    values.providerSessionId = update.providerSessionId;
  if (update.workDir !== undefined) values.workDir = update.workDir;
  if (update.branchName !== undefined) values.branchName = update.branchName;
  if (update.repoUrl !== undefined) values.repoUrl = update.repoUrl;

  const existing = await findSession(conn, key);
  if (existing) {
    await conn.query
      .updateTable('runSessions')
      .set(values)
      .where('agentId', '=', key.agentId)
      .where('runtimeId', '=', key.runtimeId)
      .where('subjectType', '=', key.subjectType)
      .where('subjectId', '=', key.subjectId)
      .execute();
    return;
  }
  await conn.query
    .insertInto('runSessions')
    .values({
      id: ids.next(),
      ...key,
      providerSessionId: null,
      workDir: null,
      createdAt: new Date(),
      ...values,
    })
    .execute();
}
