/**
 * Signal trigger rules (protocol.phase2-signals.ts). Part of the trigger module: only `trigger.service.ts` hands this
 * file its enqueue function. A source (today the GitHub integration, `git/pr-signals.ts`) reports; the rule a person
 * configured in `settings.signalRules` decides.
 *
 * | Report                                                         | Result                                          |
 * | -------------------------------------------------------------- | ----------------------------------------------- |
 * | `kind`'s rule is off (the default), or no such issue           | nothing                                         |
 * | the issue is dormant or terminal, has no owner, or a person executes it | nothing                                |
 * | the owner may not invoke the executor agent                    | nothing                                         |
 * | `key` was already received on this issue                       | nothing (one run per occurrence)                |
 * | fewer than `maxConsecutive` runs of `kind` since the last resolution | enqueue for the executor on behalf of the owner, scope null, `signal`; activity `signal_received` |
 * | the limit is reached                                           | no run; activity `signal_suppressed` and the owner's inbox, once per streak |
 * | the source reports the problem gone while a streak is open     | activity `signal_resolved`: the streak ends     |
 *
 * The run carries the owner's authority (`actorUserId`) under the rule's; the executor was put there by a person or
 * a person's rule. A blocked issue records `run_deferred_blocked` as for any trigger, and the occurrence still counts
 * as received. The streak is read back from the issue's activities, like the stage run loop guard.
 */
import { SYSTEM_ACTOR } from '../shared/activity.js';
import type { ActivityRecorder } from '../shared/activity.js';
import type { Tx } from '../shared/db.js';
import { fromJson, str } from '../shared/db.js';
import type {
  ActivityActionSignal,
  SignalPayload,
  TriggeredRun,
} from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';
import type { TriggerRecordInput } from '../run/run.service.js';
import type { SettingsService } from '../system/settings.service.js';
import { signalRuleOf } from '../system/signal-rules.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import { fillPlaceholders } from '../workflow/instruction.js';
import { canTriggerAgent } from './access.js';
import type { EnqueueTarget } from './trigger.service.js';

/** What a source reports about one issue. */
export interface SignalReport {
  readonly issueId: string;
  readonly source: string;
  readonly kind: string;
  readonly key: string;
  readonly title: string;
  readonly url: string | null;
  /** Used when the rule has no instruction of its own; `{{name}}` placeholders take `variables`. */
  readonly defaultInstruction: string;
  readonly variables: Readonly<Record<string, string>>;
}

export interface SignalResolution {
  readonly issueId: string;
  readonly source: string;
  readonly kind: string;
  readonly key: string;
}

export interface SignalTriggerDeps {
  readonly workflows: WorkflowService;
  readonly activity: ActivityRecorder;
  readonly settings: SettingsService;
  readonly enqueue: (
    tx: Tx,
    target: EnqueueTarget,
    trigger: TriggerRecordInput,
  ) => Promise<TriggeredRun | null>;
}

const SIGNAL_ACTIONS: readonly ActivityActionSignal[] = [
  'signal_received',
  'signal_suppressed',
  'signal_resolved',
];

interface SignalActivity {
  readonly action: ActivityActionSignal;
  readonly key: string | null;
}

/** The issue's signal activities of `kind`, newest first. */
async function history(
  tx: Tx,
  issueId: string,
  kind: string,
): Promise<SignalActivity[]> {
  const rows = await tx.conn.query
    .selectFrom('activities')
    .select(['action', 'details'])
    .where('issueId', '=', issueId)
    .where('action', 'in', [...SIGNAL_ACTIONS])
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const result: SignalActivity[] = [];
  for (const row of rows) {
    const details = fromJson<Record<string, unknown>>(row.details) ?? {};
    if (details.kind !== kind) continue;
    result.push({
      action: str(row.action) as ActivityActionSignal,
      key: str(details.key),
    });
  }
  return result;
}

/** The activities since the last `signal_resolved` (the open streak), newest first. */
function openStreak(entries: readonly SignalActivity[]): SignalActivity[] {
  const end = entries.findIndex((entry) => entry.action === 'signal_resolved');
  return end === -1 ? [...entries] : entries.slice(0, end);
}

export async function onSignal(
  deps: SignalTriggerDeps,
  tx: Tx,
  report: SignalReport,
): Promise<TriggeredRun | null> {
  const settings = await deps.settings.read(tx.conn);
  const rule = signalRuleOf(settings.signalRules, report.kind);
  if (!rule.enabled) return null;
  const issue = await findIssue(tx.conn, report.issueId);
  if (!issue || issue.executorType !== 'agent' || !issue.executorId)
    return null;
  if (!issue.ownerUserId) return null;
  const view = await deps.workflows.forIssue(tx.conn, issue);
  if (view.isDormant(issue.statusKey)) return null;
  // The run acts for the owner: an owner who may not invoke the executor gets no run, as for their own comments.
  if (!(await canTriggerAgent(tx, issue.ownerUserId, issue.executorId)))
    return null;
  const entries = await history(tx, issue.id, report.kind);
  if (entries.some((entry) => entry.key === report.key)) return null;
  const streak = openStreak(entries);
  const base = {
    source: report.source,
    kind: report.kind,
    key: report.key,
    title: report.title,
    url: report.url,
  };
  const received = streak.filter(
    (entry) => entry.action === 'signal_received',
  ).length;
  if (received >= rule.maxConsecutive) {
    if (streak.some((entry) => entry.action === 'signal_suppressed'))
      return null;
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor: SYSTEM_ACTOR,
      action: 'signal_suppressed',
      details: { ...base, limit: rule.maxConsecutive },
    });
    tx.emit({ type: 'issue.changed', issueId: issue.id });
    tx.emit({
      type: 'issue.signalSuppressed',
      issueId: issue.id,
      kind: report.kind,
      title: report.title,
      url: report.url,
      limit: rule.maxConsecutive,
    });
    return null;
  }
  const payload: SignalPayload = {
    ...base,
    instruction:
      fillPlaceholders(
        rule.instruction ?? report.defaultInstruction,
        report.variables,
      ) || null,
  };
  const triggered = await deps.enqueue(
    tx,
    {
      issue,
      actorUserId: issue.ownerUserId,
      agentId: issue.executorId,
      threadScope: null,
    },
    { type: 'signal', payload: { ...payload } },
  );
  await deps.activity.record(tx.conn, {
    issueId: issue.id,
    actor: SYSTEM_ACTOR,
    action: 'signal_received',
    details: {
      ...base,
      agentId: issue.executorId,
      runId: triggered?.runId ?? null,
    },
  });
  tx.emit({ type: 'issue.changed', issueId: issue.id });
  return triggered;
}

/** Ends the open streak of `kind`, if any (whether or not the rule is on: a rule turned off keeps no stale streak). */
export async function onSignalResolved(
  deps: Pick<SignalTriggerDeps, 'activity'>,
  tx: Tx,
  resolution: SignalResolution,
): Promise<void> {
  const entries = await history(tx, resolution.issueId, resolution.kind);
  if (entries.length === 0 || entries[0]?.action === 'signal_resolved') return;
  await deps.activity.record(tx.conn, {
    issueId: resolution.issueId,
    actor: SYSTEM_ACTOR,
    action: 'signal_resolved',
    details: {
      source: resolution.source,
      kind: resolution.kind,
      key: resolution.key,
    },
  });
  tx.emit({ type: 'issue.changed', issueId: resolution.issueId });
}
