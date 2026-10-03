/**
 * Read models over runs for the browser API.
 */
import type { Actor } from '../shared/activity.js';
import { canSeeIssue, viewerOf } from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { fromJson, iso, num, str, unique } from '../shared/db.js';
import { notFound } from '../shared/errors.js';
import type {
  RunDetail,
  RunSummary,
  RunTriggerItem,
  RunTriggerType,
  RuntimeType,
  RuntimeTypeFields,
} from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';
import { EXECUTING_STATUSES, findRun, mapRun } from './run.records.js';

export interface RunQueries {
  detail(runId: string): Promise<RunDetail>;
  /** 404 unless the run exists and the caller can see its issue (iteration 2 §K). */
  assertVisible(actor: Actor, runId: string): Promise<void>;
}

/** Number of dispatched | running runs per value of `column` (`subjectId` or `agentId`). */
export async function activeRunCounts(
  conn: Conn,
  column: 'subjectId' | 'agentId',
  values: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const wanted = unique(values);
  if (wanted.length === 0) return result;
  const rows = await conn.query
    .selectFrom('runs')
    .select((eb) => [column, eb.fn.countAll().as('count')])
    .where(column, 'in', wanted)
    .where('status', 'in', EXECUTING_STATUSES)
    .groupBy(column)
    .execute();
  for (const row of rows) result.set(str(row[column]) ?? '', num(row.count));
  return result;
}

export async function agentNames(
  conn: Conn,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = unique(ids);
  if (wanted.length === 0) return new Map();
  const rows = await conn.query
    .selectFrom('agents')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .execute();
  return new Map(rows.map((row) => [str(row.id) ?? '', str(row.name) ?? '']));
}

/** NP-219: `runtimeType` narrows the list to one type (`?runtimeType=`). */
export async function runSummariesForIssue(
  conn: Conn,
  issueId: string,
  runtimeType?: RuntimeType | null,
): Promise<(RunSummary & RuntimeTypeFields)[]> {
  const query = conn.query
    .selectFrom('runs')
    .selectAll()
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', issueId);
  const rows = await (
    runtimeType ? query.where('runtimeType', '=', runtimeType) : query
  )
    .orderBy('createdAt', 'desc')
    .limit(50)
    .execute();
  const runs = rows.map(mapRun);
  const names = await agentNames(
    conn,
    runs.map((run) => run.agentId),
  );
  const firstTrigger = new Map<string, RunTriggerType>();
  if (runs.length > 0) {
    const triggers = await conn.query
      .selectFrom('runTriggers')
      .select(['runId', 'type'])
      .where(
        'runId',
        'in',
        runs.map((run) => run.id),
      )
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
    for (const trigger of triggers) {
      const runId = str(trigger.runId) ?? '';
      if (!firstTrigger.has(runId))
        firstTrigger.set(runId, str(trigger.type) as RunTriggerType);
    }
  }
  return runs.map((run) => ({
    id: run.id,
    agentId: run.agentId,
    agentName: names.get(run.agentId) ?? run.agentId,
    runtimeType: run.runtimeType,
    triggerType: firstTrigger.get(run.id) ?? null,
    status: run.status,
    attempt: run.attempt,
    threadScope: run.threadScope,
    failureReason: run.failureReason,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    branchName: run.branchName,
    repoUrl: run.repoUrl,
  }));
}

function mapTrigger(row: Record<string, unknown>): RunTriggerItem {
  return {
    id: str(row.id) ?? '',
    type: (str(row.type) ?? 'assign') as RunTriggerType,
    commentId: str(row.commentId),
    payload: fromJson<Record<string, unknown>>(row.payload),
    createdById: str(row.createdById),
    createdAt: iso(row.createdAt),
  };
}

export function createRunQueries(deps: { tx: TxRunner }): RunQueries {
  return {
    async assertVisible(actor, runId) {
      const conn = deps.tx.read();
      const run = await findRun(conn, runId);
      const issue = run ? await findIssue(conn, run.subjectId) : null;
      if (
        !issue ||
        !(await canSeeIssue(conn, await viewerOf(conn, actor), issue))
      )
        throw notFound('Run');
    },
    async detail(runId) {
      const conn = deps.tx.read();
      const run = await findRun(conn, runId);
      if (!run) throw notFound('Run');
      const configuration = await conn.query
        .selectFrom('runs')
        .select('configurationSnapshot')
        .where('id', '=', runId)
        .executeTakeFirst();
      const triggers = await conn.query
        .selectFrom('runTriggers')
        .selectAll()
        .where('runId', '=', runId)
        .orderBy('createdAt', 'asc')
        .execute();
      const usage = await conn.query
        .selectFrom('runUsage')
        .selectAll()
        .where('runId', '=', runId)
        .execute();
      const names = await agentNames(conn, [run.agentId]);
      return {
        ...run,
        configurationSnapshot: fromJson(configuration?.configurationSnapshot),
        agentName: names.get(run.agentId) ?? run.agentId,
        triggers: triggers.map(mapTrigger),
        usage: usage.map((row) => ({
          provider: str(row.provider) ?? '',
          model: str(row.model) ?? undefined,
          inputTokens: num(row.inputTokens),
          outputTokens: num(row.outputTokens),
          cacheReadTokens: num(row.cacheReadTokens),
          cacheWriteTokens: num(row.cacheWriteTokens),
        })),
      };
    },
  };
}
