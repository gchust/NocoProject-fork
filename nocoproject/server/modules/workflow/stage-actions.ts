/**
 * Stage effects (NP-77 方案 §1–§3): what entering a status does, run by `triggers().onStatusChanged` inside the
 * transaction of every status write that goes through `writeStatus` or the browser PATCH (a failed run's reset does
 * not). Entry conditions are separate (`stage-guards.ts`).
 *
 * | action          | effect                                                                                       |
 * | --------------- | -------------------------------------------------------------------------------------------- |
 * | notifyOwner     | `issue.stageEntered` → the owner's inbox (`stage_entered`)                                    |
 * | runExecutor     | sets the executor to `agentId` (if given) and enqueues a `stageEntered` run on behalf of the owner, `payload.instruction` = the rendered template; an owner who may not invoke that agent gets a workflow suggestion instead |
 * | suggestExecutor | a pending executor proposal with `source = workflow` (deduplicated), decided by the owner     |
 * | checklist       | snapshots the items into `issueChecklistItems`                                                |
 *
 * Leaving a status supersedes its pending workflow suggestions (`status = superseded`, card resolved).
 *
 * A failing effect never undoes the transition: each one runs in its own savepoint and its events are only kept when
 * it succeeds. Unmet preconditions are `stage_action_skipped { action, reason }`, exceptions `stage_action_failed`,
 * the loop guard (`stageRunLimit` runs per issue and status within `stageRunWindowHours`) `stage_action_suppressed`;
 * those notify the owner (`issue.stageActionReported`) except for harmless skips (duplicate, already executor, an
 * agent entering a status that would run itself). Successes are `stage_action_applied`.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import { SYSTEM_ACTOR as SYSTEM } from '../shared/activity.js';
import { canInvokeAgent, loadAgentAccess } from '../shared/authz.js';
import type { Tx } from '../shared/db.js';
import { fromJson, now, str } from '../shared/db.js';
import type { DomainEvent } from '../shared/events.js';
import type { IdSource } from '../shared/ids.js';
import type {
  IssueV1,
  StageAction,
  StageActionSkipReason,
  StageActionType,
  TriggeredRun,
} from '../shared/protocol.js';
import { STAGE_GUARD_TYPES } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import type { SettingsService } from '../system/settings.service.js';
import { resolveExecutor } from '../issue/issue.fields.js';
import { emitUpdate, eventActor } from '../issue/issue.events.js';
import { findIssue } from '../issue/issue.records.js';
import type { WorkflowView } from '../issue/status.js';
import type { TriggerRecordInput } from '../run/run.service.js';
import { insertProposal } from '../subtask/proposal.service.js';
import type { EnqueueTarget } from '../trigger/trigger.service.js';
import { generateChecklist } from './checklist.js';
import { renderInstruction } from './instruction.js';

export interface StageActionDeps {
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly settings: SettingsService;
  readonly enqueue: (
    tx: Tx,
    target: EnqueueTarget,
    trigger: TriggerRecordInput,
  ) => Promise<TriggeredRun | null>;
}

export interface StageEntry {
  readonly before: IssueV1;
  readonly after: IssueV1;
  readonly actor: Actor;
  readonly view: WorkflowView;
}

type Outcome =
  | {
      readonly kind: 'applied';
      readonly details?: Readonly<Record<string, unknown>>;
      readonly triggered?: TriggeredRun | null;
    }
  | {
      readonly kind: 'skipped';
      readonly reason: StageActionSkipReason;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'suppressed';
      readonly details: Readonly<Record<string, unknown>>;
    };

/** Skips that are expected and need no attention from the owner. */
const QUIET_SKIPS: ReadonlySet<StageActionSkipReason> = new Set([
  'duplicate',
  'alreadyExecutor',
  'selfTriggered',
]);

async function activeAgent(tx: Tx, agentId: string): Promise<boolean> {
  return tx.conn.query
    .selectFrom('agents')
    .select('id')
    .where('id', '=', agentId)
    .where('archivedAt', 'is', null)
    .exists();
}

/** Pending workflow suggestions of the status being left become `superseded`. */
async function supersedeSuggestions(
  tx: Tx,
  issue: IssueV1,
  statusKey: string,
): Promise<void> {
  const rows = await tx.conn.query
    .selectFrom('executorProposals')
    .select('id')
    .where('issueId', '=', issue.id)
    .where('source', '=', 'workflow')
    .where('stageStatusKey', '=', statusKey)
    .where('status', '=', 'pending')
    .execute();
  const timestamp = now();
  for (const row of rows) {
    const proposalId = str(row.id) ?? '';
    await tx.conn.query
      .updateTable('executorProposals')
      .set({
        status: 'superseded',
        decidedAt: timestamp,
        reason: 'stageLeft',
        updatedAt: timestamp,
      })
      .where('id', '=', proposalId)
      .execute();
    tx.emit({
      type: 'proposal.decided',
      proposalId,
      issueId: issue.id,
      parentIssueId: null,
      actor: { type: 'system', id: null },
    });
  }
}

async function suggest(
  deps: StageActionDeps,
  tx: Tx,
  entry: StageEntry,
  agentId: string,
): Promise<Outcome> {
  const { after } = entry;
  if (!(await activeAgent(tx, agentId)))
    return {
      kind: 'skipped',
      reason: 'agentUnavailable',
      details: { agentId },
    };
  if (after.executorType === 'agent' && after.executorId === agentId)
    return { kind: 'skipped', reason: 'alreadyExecutor', details: { agentId } };
  const pending = await tx.conn.query
    .selectFrom('executorProposals')
    .select('id')
    .where('issueId', '=', after.id)
    .where('proposedAgentId', '=', agentId)
    .where('status', '=', 'pending')
    .exists();
  if (pending)
    return { kind: 'skipped', reason: 'duplicate', details: { agentId } };
  const proposal = await insertProposal(tx, deps, {
    issue: after,
    proposedAgentId: agentId,
    proposedByAgentId: null,
    sourceRunId: null,
    status: 'pending',
    actor: SYSTEM,
    source: 'workflow',
    stageStatusKey: after.statusKey,
  });
  return {
    kind: 'applied',
    details: { agentId, proposalId: proposal.id },
  };
}

/** How many `runExecutor` effects of this issue and status were applied within the window. */
async function recentStageRuns(
  deps: StageActionDeps,
  tx: Tx,
  issueId: string,
  statusKey: string,
): Promise<{ count: number; limit: number; windowHours: number }> {
  const settings = await deps.settings.read(tx.conn);
  const since = new Date(Date.now() - settings.stageRunWindowHours * 3_600_000);
  const rows = await tx.conn.query
    .selectFrom('activities')
    .select('details')
    .where('issueId', '=', issueId)
    .where('action', '=', 'stage_action_applied')
    .where('createdAt', '>=', since)
    .execute();
  const count = rows.filter((row) => {
    const details = fromJson<Record<string, unknown>>(row.details) ?? {};
    return details.action === 'runExecutor' && details.statusKey === statusKey;
  }).length;
  return {
    count,
    limit: settings.stageRunLimit,
    windowHours: settings.stageRunWindowHours,
  };
}

async function assignExecutor(
  deps: StageActionDeps,
  tx: Tx,
  entry: StageEntry,
  agentId: string,
): Promise<IssueV1> {
  const current = (await findIssue(tx.conn, entry.after.id)) ?? entry.after;
  if (current.executorType === 'agent' && current.executorId === agentId)
    return current;
  const executor = await resolveExecutor(tx.conn, deps.users, {
    type: 'agent',
    id: agentId,
  });
  const timestamp = now();
  await tx.conn.query
    .updateTable('issues')
    .set({
      ...executor,
      revision: current.revision + 1,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    })
    .where('id', '=', current.id)
    .execute();
  await deps.activity.record(tx.conn, {
    issueId: current.id,
    actor: SYSTEM,
    action: 'executor_changed',
    details: {
      from: { type: current.executorType, id: current.executorId },
      to: { type: 'agent', id: agentId },
      trigger: 'stageEntered',
    },
  });
  const assigned = (await findIssue(tx.conn, current.id)) as IssueV1;
  emitUpdate(tx, current, assigned, SYSTEM);
  return assigned;
}

async function runExecutor(
  deps: StageActionDeps,
  tx: Tx,
  entry: StageEntry,
  action: Extract<StageAction, { type: 'runExecutor' }>,
): Promise<Outcome> {
  const { before, after, actor } = entry;
  const preset = action.agentId || null;
  const agentId =
    preset ?? (after.executorType === 'agent' ? after.executorId : null);
  if (!agentId) return { kind: 'skipped', reason: 'noAgentExecutor' };
  if (!(await activeAgent(tx, agentId)))
    return {
      kind: 'skipped',
      reason: 'agentUnavailable',
      details: { agentId },
    };
  if (!after.ownerUserId) return { kind: 'skipped', reason: 'noOwner' };
  if (actor.type === 'agent' && actor.id === agentId)
    return { kind: 'skipped', reason: 'selfTriggered', details: { agentId } };
  const recent = await recentStageRuns(deps, tx, after.id, after.statusKey);
  if (recent.count >= recent.limit)
    return {
      kind: 'suppressed',
      details: {
        agentId,
        limit: recent.limit,
        windowHours: recent.windowHours,
      },
    };
  const isExecutor =
    after.executorType === 'agent' && after.executorId === agentId;
  if (!isExecutor) {
    const access = await loadAgentAccess(tx.conn, agentId);
    if (
      !access ||
      !(await canInvokeAgent(tx.conn, after.ownerUserId, access))
    ) {
      // 方案 §2 待定 5: the owner may not invoke the preset agent, so the owner decides instead.
      const suggested = await suggest(deps, tx, entry, agentId);
      return {
        kind: 'skipped',
        reason: 'ownerCannotInvoke',
        details: {
          agentId,
          downgradedTo: 'suggestExecutor',
          proposalId:
            suggested.kind === 'applied'
              ? (suggested.details?.proposalId ?? null)
              : null,
        },
      };
    }
  }
  const issue = await assignExecutor(deps, tx, entry, agentId);
  const ownerNames = await deps.users.names(tx.conn, [after.ownerUserId]);
  const instruction = action.instruction?.trim()
    ? renderInstruction(action.instruction, {
        'issue.identifier': after.identifier,
        'issue.title': after.title,
        from: before.statusKey,
        to: after.statusKey,
        'owner.name': ownerNames.get(after.ownerUserId) ?? '',
      })
    : null;
  const triggered = await deps.enqueue(
    tx,
    {
      issue,
      actorUserId: after.ownerUserId,
      agentId,
      threadScope: null,
    },
    {
      type: 'stageEntered',
      payload: { from: before.statusKey, to: after.statusKey, instruction },
      createdById: after.ownerUserId,
    },
  );
  return {
    kind: 'applied',
    details: { agentId, runId: triggered?.runId ?? null },
    triggered,
  };
}

async function applyAction(
  deps: StageActionDeps,
  tx: Tx,
  entry: StageEntry,
  action: StageAction,
): Promise<Outcome> {
  const { before, after, actor } = entry;
  switch (action.type) {
    case 'notifyOwner':
      if (!after.ownerUserId) return { kind: 'skipped', reason: 'noOwner' };
      tx.emit({
        type: 'issue.stageEntered',
        issueId: after.id,
        from: before.statusKey,
        to: after.statusKey,
        message: action.message?.trim() || null,
        actor: eventActor(actor),
      });
      return { kind: 'applied' };
    case 'checklist':
      return {
        kind: 'applied',
        details: {
          added: await generateChecklist(
            tx,
            deps.ids,
            after.id,
            after.statusKey,
            action.items,
          ),
        },
      };
    case 'suggestExecutor':
      return suggest(deps, tx, entry, action.agentId);
    case 'runExecutor':
      return runExecutor(deps, tx, entry, action);
    default:
      return { kind: 'skipped', reason: 'notImplemented' };
  }
}

const ACTIVITY_OF: Record<Outcome['kind'], string> = {
  applied: 'stage_action_applied',
  skipped: 'stage_action_skipped',
  suppressed: 'stage_action_suppressed',
};

async function report(
  deps: StageActionDeps,
  tx: Tx,
  after: IssueV1,
  type: StageActionType,
  outcome: Outcome | { kind: 'failed'; error: string },
): Promise<void> {
  const base = { action: type, statusKey: after.statusKey };
  const details =
    outcome.kind === 'failed'
      ? { ...base, error: outcome.error }
      : outcome.kind === 'skipped'
        ? { ...base, reason: outcome.reason, ...outcome.details }
        : { ...base, ...outcome.details };
  await deps.activity.record(tx.conn, {
    issueId: after.id,
    actor: SYSTEM,
    action:
      outcome.kind === 'failed'
        ? 'stage_action_failed'
        : ACTIVITY_OF[outcome.kind],
    details,
  });
  tx.emit({ type: 'issue.changed', issueId: after.id });
  const quiet =
    outcome.kind === 'applied' ||
    (outcome.kind === 'skipped' && QUIET_SKIPS.has(outcome.reason));
  if (quiet) return;
  tx.emit({
    type: 'issue.stageActionReported',
    issueId: after.id,
    statusKey: after.statusKey,
    action: type,
    outcome: outcome.kind,
    reason:
      outcome.kind === 'skipped'
        ? outcome.reason
        : outcome.kind === 'failed'
          ? outcome.error
          : null,
  });
}

/** Runs the effects of entering `after.statusKey`; returns the runs it enqueued. */
export async function onStageEntered(
  deps: StageActionDeps,
  tx: Tx,
  entry: StageEntry,
): Promise<TriggeredRun[]> {
  const { before, after, view } = entry;
  if (before.statusKey === after.statusKey) return [];
  await supersedeSuggestions(tx, after, before.statusKey);
  const triggered: TriggeredRun[] = [];
  for (const action of view.stageActions(after.statusKey)) {
    if (STAGE_GUARD_TYPES.includes(action.type)) continue;
    const buffered: DomainEvent[] = [];
    let outcome: Outcome;
    try {
      // Savepoint: a failing effect rolls back only its own writes; its events are dropped with it.
      outcome = await tx.conn.transaction((inner) =>
        applyAction(
          deps,
          { conn: inner, emit: (event) => buffered.push(event) },
          entry,
          action,
        ),
      );
    } catch (error) {
      await report(deps, tx, after, action.type, {
        kind: 'failed',
        error:
          error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
      continue;
    }
    for (const event of buffered) tx.emit(event);
    if (outcome.kind === 'applied' && outcome.triggered)
      triggered.push(outcome.triggered);
    await report(deps, tx, after, action.type, outcome);
  }
  return triggered;
}
