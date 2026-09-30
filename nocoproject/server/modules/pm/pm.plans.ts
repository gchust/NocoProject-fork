/**
 * Operation plan cards (NP-183, protocol-pm-assistant.md §4): the project manager proposes a list of operations, the
 * conversation's owner edits and executes it.
 *
 * - Agent (`/np/agent/pm/plans*`, conversation runs, `member.act`): create (every row checked first; any failing row
 *   is 400 `PLAN_INVALID` with `details.rows` and nothing is written; the plan is stored `pending` for 24 hours, a
 *   `plan` comment appears in the conversation and the conversation's other open plans become `superseded`), read,
 *   list, discard.
 * - Owner (`/np/pm/plans*`, browser; everybody else 404): read, edit (existing rows' params or `removed`, never new
 *   rows; `revision`; rechecked; a failed plan returns to pending), execute (`pending → executing` under a
 *   conditional update, then every row in one transaction as the owner with `via: 'pm_plan'`; any failure rolls
 *   everything back and leaves the plan `failed` with the row's error), discard.
 * - After an execution, `executed` or `failed`, a `plan_result` system comment lists every row and the trigger wakes
 *   the conversation's agent (`planExecuted`). Discarding wakes nobody.
 */
import type { Actor } from '../shared/activity.js';
import type { Conn, Tx } from '../shared/db.js';
import { addSeconds, now, toJson } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import {
  PM_OPERATION_TYPES,
  PM_PLAN_MAX_OPS,
  PM_PLAN_REF_PATTERN,
  PM_PLAN_SUMMARY_MAX,
  PM_PLAN_TITLE_MAX,
  PM_PLAN_TTL_HOURS,
  type PmOperation,
  type PmOperationType,
  type PmPlan,
  type PmPlanCreateRequest,
  type PmPlanEditRequest,
  type PmPlanResultRow,
  type PmPlanStatus,
} from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';
import type { RoleAssignments } from '../member/member.roles.js';
import type { RunAuth } from '../run/token.js';
import type { TriggerService } from '../trigger/trigger.service.js';
import { askerActor, requireConversationRun } from './pm-act.service.js';
import {
  checkPlan,
  executePlan,
  PlanRowFailure,
  type PlanEngineDeps,
  type RowOutcome,
} from './pm.plan-engine.js';
import {
  findPlan,
  planOps,
  planView,
  toPlanRows,
  writeCheck,
  type PlanRecord,
} from './pm.plan-records.js';

export interface PmPlanService {
  create(auth: RunAuth, input: PmPlanCreateRequest): Promise<PmPlan>;
  agentGet(auth: RunAuth, id: string): Promise<PmPlan>;
  agentList(auth: RunAuth, status: string | null): Promise<PmPlan[]>;
  agentDiscard(auth: RunAuth, id: string): Promise<PmPlan>;
  get(actor: Actor, id: string): Promise<PmPlan>;
  /** The plans of one of the member's conversations, newest first. */
  ofConversation(actor: Actor, conversationId: string): Promise<PmPlan[]>;
  edit(actor: Actor, id: string, input: PmPlanEditRequest): Promise<PmPlan>;
  execute(
    actor: Actor,
    id: string,
    input: { revision?: unknown },
  ): Promise<PmPlan>;
  discard(actor: Actor, id: string): Promise<PmPlan>;
}

export interface PmPlanDeps extends PlanEngineDeps {
  readonly ids: IdSource;
  readonly roles: () => RoleAssignments;
  readonly triggers: () => TriggerService;
}

const OPEN: readonly PmPlanStatus[] = ['pending', 'failed'];

function validateOps(input: PmPlanCreateRequest): void {
  if (
    typeof input?.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > PM_PLAN_TITLE_MAX
  )
    throw invalid(
      'INVALID_PLAN',
      `title must be 1–${PM_PLAN_TITLE_MAX} characters.`,
    );
  if (
    input.summary !== undefined &&
    (typeof input.summary !== 'string' ||
      input.summary.length > PM_PLAN_SUMMARY_MAX)
  )
    throw invalid(
      'INVALID_PLAN',
      `summary must be at most ${PM_PLAN_SUMMARY_MAX} characters.`,
    );
  if (
    !Array.isArray(input.ops) ||
    input.ops.length === 0 ||
    input.ops.length > PM_PLAN_MAX_OPS
  )
    throw invalid(
      'PLAN_TOO_LARGE',
      `A plan holds 1–${PM_PLAN_MAX_OPS} operations.`,
    );
  const refs = new Set<string>();
  for (const op of input.ops as readonly { type?: unknown; ref?: unknown }[]) {
    if (
      !PM_OPERATION_TYPES.includes(op?.type as PmOperationType) ||
      op.type === 'knowledge.propose'
    )
      throw invalid(
        'UNSUPPORTED_OPERATION',
        `${String(op?.type)} cannot be part of a plan.`,
      );
    const { ref } = op;
    if (ref === undefined) continue;
    if (
      typeof ref !== 'string' ||
      !PM_PLAN_REF_PATTERN.test(ref) ||
      refs.has(ref)
    )
      throw invalid(
        'INVALID_REF',
        `ref ${JSON.stringify(ref)} is malformed or used twice.`,
      );
    refs.add(ref);
  }
}

async function view(conn: Conn, plan: PlanRecord): Promise<PmPlan> {
  return planView(plan, await planOps(conn, plan.id));
}

/** The plan of `ownerUserId`, else 404. */
async function ownPlan(conn: Conn, userId: string, id: string) {
  const plan = await findPlan(conn, id);
  if (!plan || plan.ownerUserId !== userId) throw notFound('Plan');
  return plan;
}

async function writeComment(
  deps: PmPlanDeps,
  tx: Tx,
  input: {
    issueId: string;
    kind: 'plan' | 'plan_result';
    content: string;
    agentId?: string | null;
    runId?: string | null;
  },
): Promise<string> {
  const id = deps.ids.next();
  const timestamp = now();
  await tx.conn.query
    .insertInto('comments')
    .values({
      id,
      issueId: input.issueId,
      authorType: input.agentId ? 'agent' : 'system',
      authorId: input.agentId ?? null,
      content: input.content,
      kind: input.kind,
      parentId: null,
      rootId: id,
      sourceRunId: input.runId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
  await tx.conn.query
    .updateTable('pmConversations')
    .set({ lastMessageAt: timestamp })
    .where('issueId', '=', input.issueId)
    .execute();
  tx.emit({ type: 'issue.changed', issueId: input.issueId });
  return id;
}

async function create(
  deps: PmPlanDeps,
  auth: RunAuth,
  input: PmPlanCreateRequest,
): Promise<PmPlan> {
  validateOps(input);
  const conn = deps.tx.read();
  const conversation = await requireConversationRun(conn, auth);
  const actor = await askerActor(conn, deps.roles(), auth, conversation);
  const rows = input.ops.map((op, index) => ({
    seq: index + 1,
    ref: (op as { ref?: string }).ref ?? null,
    op,
    removed: false,
    baseline: null,
  }));
  const checks = await checkPlan(deps, { ...actor, via: 'pm_plan' }, rows);
  if (checks.some((check) => !check.ok))
    throw invalid(
      'PLAN_INVALID',
      'Some operations cannot be performed; fix them and propose again.',
      { rows: checks },
    );
  const id = deps.ids.next();
  await deps.tx.run(async (tx) => {
    const timestamp = now();
    await tx.conn.query
      .updateTable('pmPlans')
      .set({ status: 'superseded', updatedAt: timestamp })
      .where('conversationIssueId', '=', conversation.issueId)
      .where('status', 'in', [...OPEN])
      .execute();
    const commentId = await writeComment(deps, tx, {
      issueId: conversation.issueId,
      kind: 'plan',
      content: input.summary?.trim() || input.title.trim(),
      agentId: auth.agentId,
      runId: auth.runId,
    });
    await tx.conn.query
      .insertInto('pmPlans')
      .values({
        id,
        conversationIssueId: conversation.issueId,
        runId: auth.runId,
        agentId: auth.agentId,
        ownerUserId: conversation.ownerUserId,
        title: input.title.trim(),
        summary: input.summary ?? null,
        status: 'pending',
        revision: 1,
        expiresAt: addSeconds(timestamp, PM_PLAN_TTL_HOURS * 3600),
        executedAt: null,
        executedById: null,
        result: null,
        commentId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
    for (const [index, op] of input.ops.entries()) {
      const check = checks.find((item) => item.seq === index + 1);
      await tx.conn.query
        .insertInto('pmPlanOps')
        .values({
          id: deps.ids.next(),
          planId: id,
          seq: index + 1,
          ref: (op as { ref?: string }).ref ?? null,
          type: op.type,
          params: toJson(op.params ?? {}),
          baseline: toJson(check?.baseline ?? null),
          status: 'pending',
          errorCode: null,
          errorMessage: null,
          preview: toJson({
            runs: check?.preview ?? [],
            flags: check?.flags ?? [],
          }),
          resultType: null,
          resultId: null,
          warnings: toJson([]),
        })
        .execute();
    }
  });
  return view(deps.tx.read(), (await findPlan(deps.tx.read(), id))!);
}

async function agentPlan(
  deps: PmPlanDeps,
  auth: RunAuth,
  id: string,
): Promise<PlanRecord> {
  const conn = deps.tx.read();
  const conversation = await requireConversationRun(conn, auth);
  const plan = await findPlan(conn, id);
  if (!plan || plan.conversationIssueId !== conversation.issueId)
    throw notFound('Plan');
  return plan;
}

async function discard(deps: PmPlanDeps, plan: PlanRecord): Promise<PmPlan> {
  const conn = deps.tx.read();
  const moved = await conn.query
    .updateTable('pmPlans')
    .set({ status: 'discarded', updatedAt: now() })
    .where('id', '=', plan.id)
    .where('status', 'in', [...OPEN])
    .execute();
  if (Number(moved.updatedCount) === 0)
    throw conflict('PLAN_NOT_PENDING', `The plan is ${plan.status}.`);
  return view(conn, (await findPlan(conn, plan.id))!);
}

function requireOpen(plan: PlanRecord): void {
  if (plan.status === 'expired')
    throw conflict('PLAN_EXPIRED', 'The plan expired; ask for a new one.');
  if (!OPEN.includes(plan.status))
    throw conflict('PLAN_NOT_PENDING', `The plan is ${plan.status}.`);
}

async function edit(
  deps: PmPlanDeps,
  actor: Actor,
  id: string,
  input: PmPlanEditRequest,
): Promise<PmPlan> {
  const conn = deps.tx.read();
  const plan = await ownPlan(conn, actor.id ?? '', id);
  requireOpen(plan);
  if (input?.revision !== plan.revision)
    throw conflict('REVISION_CONFLICT', 'The plan changed; reload it.');
  const ops = await planOps(conn, id);
  const requested: PmPlanEditRequest['ops'] = Array.isArray(input.ops)
    ? input.ops
    : [];
  const edits = new Map(requested.map((item) => [item.seq, item]));
  for (const seq of edits.keys())
    if (!ops.some((op) => op.seq === seq))
      throw invalid(
        'INVALID_PLAN',
        `Row ${seq} does not exist; plans take no new rows.`,
      );
  const rows = toPlanRows(ops).map((row) => {
    const change = edits.get(row.seq);
    if (!change) return row;
    return {
      ...row,
      removed: change.removed === true ? true : row.removed,
      op:
        change.params === undefined
          ? row.op
          : ({ ...row.op, params: change.params } as PmOperation),
    };
  });
  const removedRefs = new Set(
    rows
      .filter((row) => row.removed && row.ref)
      .map((row) => row.ref as string),
  );
  for (const row of rows)
    if (
      !row.removed &&
      [...removedRefs].some((ref) =>
        JSON.stringify(row.op.params).includes(`"ref":"${ref}"`),
      )
    )
      throw invalid('INVALID_REF', `Row ${row.seq} uses a removed row.`);
  const checks = await checkPlan(deps, { ...actor, via: 'pm_plan' }, rows);
  await deps.tx.run(async (tx) => {
    for (const row of rows) {
      const change = edits.get(row.seq);
      if (change)
        await tx.conn.query
          .updateTable('pmPlanOps')
          .set({
            params: toJson(row.op.params ?? {}),
            status: row.removed ? 'removed' : 'pending',
          })
          .where('planId', '=', id)
          .where('seq', '=', row.seq)
          .execute();
      const check = checks.find((item) => item.seq === row.seq);
      if (check) await writeCheck(tx.conn, id, check, !!change);
    }
    await tx.conn.query
      .updateTable('pmPlans')
      .set({ revision: plan.revision + 1, status: 'pending', updatedAt: now() })
      .where('id', '=', id)
      .execute();
  });
  return view(deps.tx.read(), (await findPlan(deps.tx.read(), id))!);
}

function resultRows(
  outcomes: readonly RowOutcome[],
  failure: PlanRowFailure | null,
  rows: ReturnType<typeof toPlanRows>,
): PmPlanResultRow[] {
  return rows
    .filter((row) => !row.removed)
    .map((row) => {
      const done = outcomes.find((item) => item.seq === row.seq);
      const failed = failure?.seq === row.seq;
      return {
        seq: row.seq,
        type: row.op.type,
        ok: !!done && !failure,
        ...(failed ? { errorCode: failure.errorCode } : {}),
        ...(done?.object && !failure
          ? {
              resultType: done.object.type,
              resultId: done.object.id,
              identifier: done.object.identifier ?? null,
            }
          : {}),
        warnings: done?.warnings ? [...done.warnings] : [],
      };
    });
}

function resultText(
  status: 'executed' | 'failed',
  rows: readonly PmPlanResultRow[],
  failure: PlanRowFailure | null,
): string {
  const lines = rows.map((row) =>
    row.ok
      ? `- ✓ ${row.seq}. ${row.type}${row.identifier ? ` ${row.identifier}` : ''}${row.warnings.includes('runNotStarted') ? ' (run not started)' : ''}`
      : row.errorCode
        ? `- ✗ ${row.seq}. ${row.type}: ${row.errorCode} ${failure?.errorMessage ?? ''}`.trimEnd()
        : `- · ${row.seq}. ${row.type}: not run`,
  );
  const head =
    status === 'executed'
      ? 'Plan executed.'
      : 'Plan failed; nothing was changed.';
  return [head, ...lines].join('\n');
}

async function finish(
  deps: PmPlanDeps,
  tx: Tx,
  plan: PlanRecord,
  actor: Actor,
  status: 'executed' | 'failed',
  rows: PmPlanResultRow[],
  failure: PlanRowFailure | null,
): Promise<void> {
  const timestamp = now();
  for (const row of rows)
    await tx.conn.query
      .updateTable('pmPlanOps')
      .set({
        status: row.ok ? 'done' : row.errorCode ? 'failed' : 'pending',
        errorCode: row.errorCode ?? null,
        errorMessage: row.errorCode ? (failure?.errorMessage ?? null) : null,
        resultType: row.resultType ?? null,
        resultId: row.resultId ?? null,
        warnings: toJson(row.warnings),
      })
      .where('planId', '=', plan.id)
      .where('seq', '=', row.seq)
      .execute();
  await tx.conn.query
    .updateTable('pmPlans')
    .set({
      status,
      executedAt: status === 'executed' ? timestamp : null,
      executedById: actor.id,
      result: toJson({ status, rows }),
      updatedAt: timestamp,
    })
    .where('id', '=', plan.id)
    .execute();
  const commentId = await writeComment(deps, tx, {
    issueId: plan.conversationIssueId,
    kind: 'plan_result',
    content: resultText(status, rows, failure),
  });
  const conversation = await findIssue(tx.conn, plan.conversationIssueId);
  if (conversation)
    await deps.triggers().onPlanFinished(tx, {
      conversation,
      actorUserId: plan.ownerUserId,
      payload: { planId: plan.id, status, results: rows },
      commentId,
    });
}

async function execute(
  deps: PmPlanDeps,
  actor: Actor,
  id: string,
  input: { revision?: unknown },
): Promise<PmPlan> {
  const conn = deps.tx.read();
  const plan = await ownPlan(conn, actor.id ?? '', id);
  if (plan.status === 'expired')
    throw conflict('PLAN_EXPIRED', 'The plan expired; ask for a new one.');
  const before = await view(conn, plan);
  if (plan.status === 'pending' && !before.executable)
    throw invalid(
      'PLAN_INVALID',
      'Fix or remove the rows that cannot be performed first.',
      { rows: before.rows },
    );
  const moved = await conn.query
    .updateTable('pmPlans')
    .set({ status: 'executing', updatedAt: now() })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .where('revision', '=', Number(input?.revision))
    .execute();
  if (Number(moved.updatedCount) === 0) {
    const current = await findPlan(conn, id);
    if (current?.status === 'expired')
      throw conflict('PLAN_EXPIRED', 'The plan expired; ask for a new one.');
    if (
      current?.status === 'pending' &&
      current.revision !== Number(input?.revision)
    )
      throw conflict('REVISION_CONFLICT', 'The plan changed; reload it.');
    throw conflict(
      'PLAN_NOT_PENDING',
      `The plan is ${current?.status ?? 'gone'}.`,
    );
  }
  const rows = toPlanRows(await planOps(conn, id));
  const member: Actor = {
    ...actor,
    via: 'pm_plan',
    pm: { conversationId: plan.conversationIssueId, planId: id },
  };
  try {
    await deps.tx.run(async (tx) => {
      const outcomes = await executePlan(deps, tx, member, rows);
      await finish(
        deps,
        tx,
        plan,
        actor,
        'executed',
        resultRows(outcomes, null, rows),
        null,
      );
    });
  } catch (error) {
    if (!(error instanceof PlanRowFailure)) {
      await conn.query
        .updateTable('pmPlans')
        .set({ status: 'pending', updatedAt: now() })
        .where('id', '=', id)
        .execute();
      throw error;
    }
    await deps.tx.run((tx) =>
      finish(
        deps,
        tx,
        plan,
        actor,
        'failed',
        resultRows(error.done, error, rows),
        error,
      ),
    );
  }
  return view(deps.tx.read(), (await findPlan(deps.tx.read(), id))!);
}

export function createPmPlanService(deps: PmPlanDeps): PmPlanService {
  return {
    create: (auth, input) => create(deps, auth, input),
    agentGet: async (auth, id) =>
      view(deps.tx.read(), await agentPlan(deps, auth, id)),
    async agentList(auth, status) {
      const conn = deps.tx.read();
      const conversation = await requireConversationRun(conn, auth);
      let query = conn.query
        .selectFrom('pmPlans')
        .select('id')
        .where('conversationIssueId', '=', conversation.issueId);
      if (status) query = query.where('status', '=', status);
      const rows = await query.orderBy('createdAt', 'desc').limit(50).execute();
      const plans: PmPlan[] = [];
      for (const row of rows) {
        const plan = await findPlan(conn, String(row.id));
        if (plan) plans.push(await view(conn, plan));
      }
      return plans;
    },
    agentDiscard: async (auth, id) =>
      discard(deps, await agentPlan(deps, auth, id)),
    get: async (actor, id) => {
      const conn = deps.tx.read();
      return view(conn, await ownPlan(conn, actor.id ?? '', id));
    },
    async ofConversation(actor, conversationId) {
      const conn = deps.tx.read();
      const rows = await conn.query
        .selectFrom('pmPlans')
        .select('id')
        .where('conversationIssueId', '=', conversationId)
        .where('ownerUserId', '=', actor.id ?? '')
        .orderBy('createdAt', 'desc')
        .execute();
      const plans: PmPlan[] = [];
      for (const row of rows) {
        const plan = await findPlan(conn, String(row.id));
        if (plan) plans.push(await view(conn, plan));
      }
      return plans;
    },
    edit: (actor, id, input) => edit(deps, actor, id, input),
    execute: (actor, id, input) => execute(deps, actor, id, input),
    discard: async (actor, id) =>
      discard(deps, await ownPlan(deps.tx.read(), actor.id ?? '', id)),
  };
}
