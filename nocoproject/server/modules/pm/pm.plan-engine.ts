/**
 * Checking and executing an operation plan card (NP-183, protocol-pm-assistant.md §4.3, §4.5). Both run the rows
 * through `performOperation` — the same services, permissions and trigger rules as the browser — as the plan's
 * owner:
 *
 * - `checkPlan` rehearses the whole plan inside a transaction that is always rolled back: every row in its own
 *   savepoint, so one failing row still lets the next ones be checked (a row naming a failed row's `ref` fails with
 *   `INVALID_REF`). Each row reports its error, the runs it would start (`trigger/preview.ts`), its flags and, for
 *   `issue.update` / `issue.status`, the current values of the fields it changes (`baseline`).
 * - `executePlan` runs the rows for real in one transaction; the first failing row (a service error, or
 *   `STALE_TARGET` when a baselined field changed since) rolls everything back. Runs the trigger rules skipped (the
 *   member may not invoke the agent) become the row's `runNotStarted` warning, like a comment saved without its run.
 *
 * Domain events are emitted only after the outermost commit, so a rehearsal notifies nobody and wakes no daemon.
 */
import type { Actor } from '../shared/activity.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { NpError } from '../shared/errors.js';
import type {
  PmOperation,
  PmPlanRowCheck,
  PmPlanRowFlag,
  RunPreview,
} from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';
import { agentNames } from '../run/run.queries.js';
import { collectRuns, type RunAttempt } from '../trigger/preview.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import {
  performOperation,
  targetId,
  type OperationDeps,
  type PerformedObject,
  type PlanRefs,
} from './pm.operations.js';
import { performDecision, type DecisionDeps } from './pm.plan-decisions.js';

export interface PlanEngineDeps extends OperationDeps, DecisionDeps {
  readonly tx: TxRunner;
  readonly workflows: WorkflowService;
}

export interface PlanRow {
  readonly seq: number;
  readonly ref: string | null;
  readonly op: PmOperation;
  readonly removed: boolean;
  readonly baseline: Readonly<Record<string, unknown>> | null;
}

export interface RowOutcome {
  readonly seq: number;
  readonly object: PerformedObject | null;
  readonly warnings: readonly string[];
}

class Rehearsal extends Error {}

/** The fields an `issue.update` / `issue.status` row changes, as they are now. */
async function baselineOf(
  tx: Tx,
  op: PmOperation,
  refs: PlanRefs,
): Promise<Record<string, unknown> | undefined> {
  if (op.type !== 'issue.update' && op.type !== 'issue.status') return undefined;
  const issue = await findIssue(tx.conn, targetId(op.params.issue, refs));
  if (!issue) return undefined;
  const current = issue as unknown as Record<string, unknown>;
  if (op.type === 'issue.status') return { statusKey: issue.statusKey };
  const fields = Object.keys(op.params.set ?? {});
  return Object.fromEntries(
    fields.map((field) =>
      field === 'executor'
        ? [field, { type: issue.executorType, id: issue.executorId }]
        : [field, current[field] ?? null],
    ),
  );
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function flagsOf(
  deps: PlanEngineDeps,
  tx: Tx,
  op: PmOperation,
  refs: PlanRefs,
  started: readonly RunAttempt[],
): Promise<PmPlanRowFlag[]> {
  const flags: PmPlanRowFlag[] = [];
  if (started.length > 0) flags.push('startsRun');
  if (op.type === 'decision.resolve') flags.push('decision');
  if (op.type === 'project.create') flags.push('createsProject');
  if (op.type === 'issue.update' && op.params.set?.ownerUserId !== undefined)
    flags.push('ownerChange');
  if (op.type === 'issue.create' && op.params.ownerUserId !== undefined)
    flags.push('ownerChange');
  if (op.type === 'issue.status') {
    const issue = await findIssue(tx.conn, targetId(op.params.issue, refs));
    if (issue && (await deps.workflows.forIssue(tx.conn, issue)).isTerminal(op.params.statusKey))
      flags.push('terminal');
  }
  return flags;
}

async function previewOf(
  tx: Tx,
  attempts: readonly RunAttempt[],
): Promise<RunPreview[]> {
  const names = await agentNames(tx.conn, attempts.map((run) => run.agentId));
  return attempts.map((run) => ({
    agentId: run.agentId,
    agentName: names.get(run.agentId) ?? null,
    issueId: run.issueId,
    triggerType: run.triggerType,
  }));
}

async function perform(
  deps: PlanEngineDeps,
  tx: Tx,
  actor: Actor,
  op: PmOperation,
  refs: PlanRefs,
): Promise<PerformedObject> {
  if (op.type === 'decision.resolve' || op.type === 'project.create') {
    const object = await performDecision(deps, tx, actor, op);
    if (op.type === 'project.create' && op.ref)
      refs.set(op.ref, { type: 'project', id: object.id });
    return object;
  }
  return performOperation(deps, tx, actor, op, refs);
}

function errorOf(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof NpError)
    return { errorCode: error.code, errorMessage: error.message };
  return { errorCode: 'INTERNAL_ERROR', errorMessage: 'The operation failed.' };
}

/** Rehearses the plan and rolls back; one check per row that is not removed. */
export async function checkPlan(
  deps: PlanEngineDeps,
  actor: Actor,
  rows: readonly PlanRow[],
): Promise<PmPlanRowCheck[]> {
  const checks: PmPlanRowCheck[] = [];
  await deps.tx
    .run(async (tx) => {
      const refs: PlanRefs = new Map();
      for (const row of rows) {
        if (row.removed) continue;
        const baseline = await baselineOf(tx, row.op, refs).catch(() => undefined);
        try {
          const { runs } = await tx.conn.transaction(async (inner) =>
            collectRuns(() =>
              perform(deps, { conn: inner, emit: tx.emit }, actor, row.op, refs),
            ),
          );
          const started = runs.filter((run) => run.started);
          checks.push({
            seq: row.seq,
            ok: true,
            preview: await previewOf(tx, started),
            flags: await flagsOf(deps, tx, row.op, refs, started),
            ...(baseline ? { baseline } : {}),
          });
        } catch (error) {
          checks.push({
            seq: row.seq,
            ok: false,
            ...errorOf(error),
            preview: [],
            flags: [],
            ...(baseline ? { baseline } : {}),
          });
        }
      }
      throw new Rehearsal();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rehearsal)) throw error;
    });
  return checks;
}

export class PlanRowFailure extends Error {
  constructor(
    readonly seq: number,
    readonly errorCode: string,
    readonly errorMessage: string,
    readonly done: readonly RowOutcome[],
  ) {
    super(errorMessage);
  }
}

/** Executes the rows in `tx`; throws `PlanRowFailure` (the caller rolls back) at the first failing row. */
export async function executePlan(
  deps: PlanEngineDeps,
  tx: Tx,
  actor: Actor,
  rows: readonly PlanRow[],
): Promise<RowOutcome[]> {
  const refs: PlanRefs = new Map();
  const done: RowOutcome[] = [];
  for (const row of rows) {
    if (row.removed) continue;
    try {
      if (row.baseline) {
        const current = await baselineOf(tx, row.op, refs);
        if (!same(current, row.baseline))
          throw new NpError(
            'conflict',
            'STALE_TARGET',
            'The issue changed after the plan was made; edit the row or ask for a new plan.',
          );
      }
      const { value, runs } = await collectRuns(() =>
        perform(deps, tx, actor, row.op, refs),
      );
      done.push({
        seq: row.seq,
        object: value,
        warnings: runs.some((run) => run.skipped === 'denied')
          ? ['runNotStarted']
          : [],
      });
    } catch (error) {
      const { errorCode, errorMessage } = errorOf(error);
      throw new PlanRowFailure(row.seq, errorCode, errorMessage, done);
    }
  }
  return done;
}
