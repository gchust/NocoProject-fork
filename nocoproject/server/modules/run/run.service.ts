/**
 * Run lifecycle: enqueue (called only by the trigger service), lease, start, complete, cancel.
 *
 * Failures and retries live in `failure.ts`, events in `run-events.ts`, claiming in `claim.service.ts`.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { addSeconds, isUniqueViolation, now, toJson } from '../shared/db.js';
import { conflict, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import {
  CLAIM_LEASE_SECONDS,
  type DaemonCompleteRequest,
  type DaemonReportPhase1Extras,
  type DaemonRunStatusResponse,
  type DaemonStartRequest,
  type Run,
  type RunTriggerTypeV7,
  type RunStatus,
} from '../shared/protocol.js';
import {
  ACTIVE_STATUSES,
  EXECUTING_STATUSES,
  PENDING_STATUSES,
  findRun,
  revokeRunTokens,
  runtimeOwnerOf,
  transitionRun,
} from './run.records.js';
import { markRetrospectiveDone } from './retrospective.js';
import {
  acceptsRunInput,
  currentInputRun,
  lockRun,
  requireHandledInputs,
  runInputs,
} from './input.js';
import { upsertSession } from './sessions.js';

export interface TriggerRecordInput {
  /** Iteration 4 adds `designApproved` and `retrospective`, Phase 2 `stageEntered` and `signal`, NP-183 `planExecuted`. */
  readonly type: RunTriggerTypeV7;
  readonly commentId?: string | null;
  readonly payload?: Readonly<Record<string, unknown>> | null;
  readonly createdById?: string | null;
}

export interface EnqueueInput {
  readonly agentId: string;
  readonly subjectId: string;
  readonly threadScope: string | null;
  readonly actorUserId: string | null;
  readonly ownerUserId: string | null;
  readonly priority: number;
  readonly triggers: readonly TriggerRecordInput[];
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly retryOfRunId?: string | null;
  /** A future time makes the run `deferred` until the sweeper promotes it. */
  readonly fireAt?: Date | null;
  /** Only human comment triggers may join a live run. */
  readonly appendInput?: boolean;
}

export interface EnqueueResult {
  readonly runId: string;
  /** true when the triggers were appended to an existing pending run instead of creating one */
  readonly coalesced: boolean;
}

export const DEFAULT_MAX_ATTEMPTS = 2;

export interface RunService {
  /** Only the trigger service calls this (protocol.md §2). Joins the caller's transaction. */
  enqueue(tx: Tx, input: EnqueueInput): Promise<EnqueueResult>;
  get(runId: string): Promise<Run>;
  currentInputRun: typeof currentInputRun;
  extendLease(runId: string): Promise<Run>;
  start(runId: string, input: DaemonStartRequest): Promise<Run>;
  daemonStatus(runId: string): Promise<DaemonRunStatusResponse>;
  complete(
    runId: string,
    input: DaemonCompleteRequest & DaemonReportPhase1Extras,
  ): Promise<Run>;
  requestCancel(actor: Actor, runId: string): Promise<Run>;
  cancelAck(runId: string): Promise<Run>;
  /**
   * Withdraws a run that was not handed to a daemon yet (queued / deferred) inside `tx`: cancelled with
   * the supplied reason (defaults to `blocked`, iteration 2 §K). False when it had already moved on.
   */
  withdrawQueued(
    tx: Tx,
    run: Run,
    reason?: 'blocked' | 'cancelled',
  ): Promise<boolean>;
}

export interface RunServiceDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  /** Iteration 4: records `retrospective_done` when a retrospective run completes. */
  readonly activity?: ActivityRecorder;
}

/** Emits the invalidation events every run status change produces. */
export function emitRunStatus(
  tx: Tx,
  run: { id: string; subjectId: string },
  status: RunStatus,
): void {
  tx.emit({
    type: 'run.status',
    runId: run.id,
    issueId: run.subjectId,
    status,
  });
  tx.emit({ type: 'issue.changed', issueId: run.subjectId });
  tx.emit({ type: 'agents.changed' });
}

/** Tells the daemon that owns `runtimeId` that there is work to claim. */
export async function emitWorkAvailable(
  tx: Tx,
  runtimeId: string | null,
): Promise<void> {
  const userId = await runtimeOwnerOf(tx.conn, runtimeId);
  if (userId && runtimeId)
    tx.emit({ type: 'daemon.workAvailable', userId, runtimeId });
}

export async function insertTriggers(
  tx: Tx,
  ids: IdSource,
  runId: string,
  triggers: readonly TriggerRecordInput[],
): Promise<void> {
  if (triggers.length === 0) return;
  const createdAt = now();
  await tx.conn.query
    .insertInto('runTriggers')
    .values(
      triggers.map((trigger) => ({
        id: ids.next(),
        runId,
        type: trigger.type,
        commentId: trigger.commentId ?? null,
        payload: toJson(trigger.payload ?? null),
        createdById: trigger.createdById ?? null,
        createdAt,
      })),
    )
    .execute();
}

async function findPendingRunId(
  tx: Tx,
  input: EnqueueInput,
): Promise<string | null> {
  const query = tx.conn.query
    .selectFrom('runs')
    .select('id')
    .where('agentId', '=', input.agentId)
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', input.subjectId)
    .where('status', 'in', PENDING_STATUSES);
  const scoped =
    input.threadScope === null
      ? query.where('threadScope', 'is', null)
      : query.where('threadScope', '=', input.threadScope);
  const row = await scoped.orderBy('createdAt', 'asc').executeTakeFirst();
  return row ? String(row.id) : null;
}

async function insertRun(
  tx: Tx,
  ids: IdSource,
  input: EnqueueInput,
  runtimeId: string | null,
): Promise<{ id: string; status: RunStatus }> {
  const timestamp = now();
  const deferred =
    input.fireAt !== undefined &&
    input.fireAt !== null &&
    input.fireAt > timestamp;
  const id = ids.next();
  const status: RunStatus = deferred ? 'deferred' : 'queued';
  // A savepoint: on PostgreSQL a concurrent enqueue can hit the pending-run unique index, and the failed INSERT must
  // not abort the caller's transaction.
  await tx.conn.transaction(async (inner) => {
    await inner.query
      .insertInto('runs')
      .values({
        id,
        agentId: input.agentId,
        runtimeId,
        kind: 'issue',
        status,
        priority: input.priority,
        attempt: input.attempt ?? 1,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        retryOfRunId: input.retryOfRunId ?? null,
        subjectType: 'issue',
        subjectId: input.subjectId,
        threadScope: input.threadScope,
        actorUserId: input.actorUserId,
        ownerUserId: input.ownerUserId,
        fireAt: input.fireAt ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
  });
  return { id, status };
}

async function enqueue(
  deps: RunServiceDeps,
  tx: Tx,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const agent = await tx.conn.query
    .selectFrom('agents')
    .select(['id', 'runtimeId'])
    .where('id', '=', input.agentId)
    .executeTakeFirst();
  if (!agent) throw notFound('Agent');
  const runtimeId = (agent.runtimeId as string | null) ?? null;
  if (input.appendInput) {
    const candidate = await currentInputRun(
      tx,
      input.subjectId,
      input.actorUserId,
      input.agentId,
    );
    if (candidate) {
      await lockRun(tx.conn, candidate.id);
      const current = await currentInputRun(
        tx,
        input.subjectId,
        input.actorUserId,
        input.agentId,
      );
      if (current?.id === candidate.id) {
        await insertTriggers(tx, deps.ids, current.id, input.triggers);
        tx.emit({ type: 'issue.changed', issueId: input.subjectId });
        return { runId: current.id, coalesced: true };
      }
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pendingId = await findPendingRunId(tx, input);
    if (pendingId) {
      await lockRun(tx.conn, pendingId);
      if ((await findPendingRunId(tx, input)) !== pendingId) continue;
      await insertTriggers(tx, deps.ids, pendingId, input.triggers);
      tx.emit({ type: 'issue.changed', issueId: input.subjectId });
      return { runId: pendingId, coalesced: true };
    }
    try {
      const created = await insertRun(tx, deps.ids, input, runtimeId);
      await insertTriggers(tx, deps.ids, created.id, input.triggers);
      emitRunStatus(
        tx,
        { id: created.id, subjectId: input.subjectId },
        created.status,
      );
      if (created.status === 'queued') await emitWorkAvailable(tx, runtimeId);
      return { runId: created.id, coalesced: false };
    } catch (error) {
      // Lost the race to a concurrent enqueue of the same key: coalesce into the run it created.
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw conflict(
    'ENQUEUE_CONFLICT',
    'Could not enqueue the run; retry the request.',
  );
}

async function requireRun(deps: RunServiceDeps, runId: string): Promise<Run> {
  const run = await findRun(deps.tx.read(), runId);
  if (!run) throw notFound('Run');
  return run;
}

function notInState(run: Run, expected: string): never {
  throw conflict(
    'RUN_STATE_CONFLICT',
    `Run is ${run.status}; expected ${expected}.`,
  );
}

async function extendLease(deps: RunServiceDeps, runId: string): Promise<Run> {
  const run = await requireRun(deps, runId);
  const leaseExpiresAt = addSeconds(now(), CLAIM_LEASE_SECONDS);
  const moved = await transitionRun(deps.tx.read(), runId, ['dispatched'], {
    leaseExpiresAt,
  });
  if (!moved) notInState(run, 'dispatched');
  return requireRun(deps, runId);
}

async function start(
  deps: RunServiceDeps,
  runId: string,
  input: DaemonStartRequest,
): Promise<Run> {
  return deps.tx.run(async (tx) => {
    const run = await findRun(tx.conn, runId);
    if (!run) throw notFound('Run');
    if (run.status === 'running') return run;
    const moved = await transitionRun(tx.conn, runId, ['dispatched'], {
      status: 'running',
      acceptsInput: input.acceptsInput === true,
      startedAt: now(),
      leaseExpiresAt: null,
      providerSessionId: input.providerSessionId ?? run.providerSessionId,
      workDir: input.workDir ?? run.workDir,
    });
    if (!moved) notInState(run, 'dispatched');
    emitRunStatus(tx, run, 'running');
    return (await findRun(tx.conn, runId)) ?? run;
  });
}

/** `branchName` / `repoUrl` reported by the daemon (contract §I), trimmed to their column sizes. */
export function checkoutReport(input: DaemonReportPhase1Extras): {
  branchName?: string | null;
  repoUrl?: string | null;
} {
  const result: { branchName?: string | null; repoUrl?: string | null } = {};
  if (typeof input?.branchName === 'string' && input.branchName.trim())
    result.branchName = input.branchName.trim().slice(0, 255);
  if (typeof input?.repoUrl === 'string' && input.repoUrl.trim())
    result.repoUrl = input.repoUrl.trim().slice(0, 2000);
  return result;
}

async function complete(
  deps: RunServiceDeps,
  runId: string,
  input: DaemonCompleteRequest & DaemonReportPhase1Extras,
): Promise<Run> {
  return deps.tx.run(async (tx) => {
    await lockRun(tx.conn, runId);
    const run = await findRun(tx.conn, runId);
    if (!run) throw notFound('Run');
    if (run.status === 'completed') return run;
    if (run.cancelRequestedAt)
      throw conflict(
        'RUN_CANCEL_REQUESTED',
        'Cancellation must be acknowledged.',
      );
    if (await acceptsRunInput(tx.conn, runId))
      await requireHandledInputs(tx.conn, runId, input.handledInputIds);
    const providerSessionId = input.providerSessionId ?? run.providerSessionId;
    const checkout = checkoutReport(input);
    const moved = await transitionRun(tx.conn, runId, EXECUTING_STATUSES, {
      status: 'completed',
      finishedAt: now(),
      leaseExpiresAt: null,
      resultSummary: input.summary ?? null,
      providerSessionId,
      workDir: input.workDir ?? run.workDir,
      ...checkout,
    });
    if (!moved) notInState(run, 'dispatched or running');
    await revokeRunTokens(tx.conn, runId);
    await upsertSession(tx.conn, deps.ids, run, {
      providerSessionId,
      workDir: input.workDir ?? run.workDir,
      poisoned: false,
      ...checkout,
    });
    if (input.usage) {
      await tx.conn.query
        .insertInto('runUsage')
        .values({
          id: deps.ids.next(),
          runId,
          provider: input.usage.provider,
          model: input.usage.model ?? null,
          inputTokens: Math.max(0, Math.trunc(input.usage.inputTokens || 0)),
          outputTokens: Math.max(0, Math.trunc(input.usage.outputTokens || 0)),
          cacheReadTokens: Math.max(
            0,
            Math.trunc(input.usage.cacheReadTokens ?? 0),
          ),
          cacheWriteTokens: Math.max(
            0,
            Math.trunc(input.usage.cacheWriteTokens ?? 0),
          ),
          createdAt: now(),
        })
        .execute();
    }
    if (deps.activity) await markRetrospectiveDone(tx, deps.activity, run);
    emitRunStatus(tx, run, 'completed');
    return (await findRun(tx.conn, runId)) ?? run;
  });
}

async function requestCancel(
  deps: RunServiceDeps,
  actor: Actor,
  runId: string,
): Promise<Run> {
  return deps.tx.run(async (tx) => {
    const run = await findRun(tx.conn, runId);
    if (!run) throw notFound('Run');
    const timestamp = now();
    // Not yet handed to a daemon: nothing to stop, cancel directly.
    const direct = await transitionRun(tx.conn, runId, ['queued', 'deferred'], {
      status: 'cancelled',
      failureReason: 'cancelled',
      cancelRequestedAt: timestamp,
      cancelledById: actor.id,
      finishedAt: timestamp,
    });
    if (direct) {
      emitRunStatus(tx, run, 'cancelled');
      return (await findRun(tx.conn, runId)) ?? run;
    }
    // Handed to a daemon: ask it to stop; the run is cancelled when it acknowledges.
    const requested = await transitionRun(tx.conn, runId, EXECUTING_STATUSES, {
      cancelRequestedAt: timestamp,
      cancelledById: actor.id,
    });
    if (requested) {
      const userId = await runtimeOwnerOf(tx.conn, run.runtimeId);
      if (userId) tx.emit({ type: 'daemon.cancelRequested', userId, runId });
      tx.emit({ type: 'issue.changed', issueId: run.subjectId });
    }
    return (await findRun(tx.conn, runId)) ?? run;
  });
}

async function cancelAck(deps: RunServiceDeps, runId: string): Promise<Run> {
  return deps.tx.run(async (tx) => {
    const run = await findRun(tx.conn, runId);
    if (!run) throw notFound('Run');
    if (run.status === 'cancelled') return run;
    const moved = await transitionRun(tx.conn, runId, ACTIVE_STATUSES, {
      status: 'cancelled',
      failureReason: 'cancelled',
      finishedAt: now(),
      leaseExpiresAt: null,
      cancelRequestedAt: run.cancelRequestedAt ?? now(),
    });
    if (!moved) notInState(run, 'active');
    await revokeRunTokens(tx.conn, runId);
    emitRunStatus(tx, run, 'cancelled');
    return (await findRun(tx.conn, runId)) ?? run;
  });
}

export function createRunService(deps: RunServiceDeps): RunService {
  return {
    currentInputRun,
    enqueue: (tx, input) => enqueue(deps, tx, input),
    get: (runId) => requireRun(deps, runId),
    extendLease: (runId) => extendLease(deps, runId),
    start: (runId, input) => start(deps, runId, input),
    async daemonStatus(runId) {
      const run = await requireRun(deps, runId);
      return {
        status: run.status,
        cancelRequested: run.cancelRequestedAt !== null,
        ...((await acceptsRunInput(deps.tx.read(), runId))
          ? { inputs: await runInputs(deps.tx.read(), runId) }
          : {}),
      };
    },
    complete: (runId, input) => complete(deps, runId, input),
    requestCancel: (actor, runId) => requestCancel(deps, actor, runId),
    cancelAck: (runId) => cancelAck(deps, runId),
    async withdrawQueued(tx, run, reason = 'blocked') {
      const timestamp = now();
      const moved = await transitionRun(
        tx.conn,
        run.id,
        ['queued', 'deferred'],
        {
          status: 'cancelled',
          // `blocked` is the iteration 2 reason (FailureReasonV2); the column is free text.
          failureReason: reason,
          finishedAt: timestamp,
        },
      );
      if (moved) emitRunStatus(tx, run, 'cancelled');
      return moved;
    },
  };
}
