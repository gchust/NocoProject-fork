import type {
  CommentThread,
  IssueActivity,
  IssueDetail,
  RunSummary,
} from '../../types.js';

export type TimelineEntry =
  | {
      readonly kind: 'thread';
      readonly key: string;
      readonly at: string;
      readonly thread: CommentThread;
    }
  | {
      readonly kind: 'activity';
      readonly key: string;
      readonly at: string;
      readonly activity: IssueActivity;
    }
  | {
      readonly kind: 'run';
      readonly key: string;
      readonly at: string;
      readonly run: RunSummary;
    };

/**
 * Comments (as threads), activities and run summaries on one chronological line, oldest first. A run sits where it
 * was triggered and describes its current state, so a finished run does not appear twice.
 */
export function buildTimeline(
  detail: Pick<IssueDetail, 'threads' | 'activities' | 'runs'>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...detail.threads.map((thread): TimelineEntry => ({
      kind: 'thread',
      key: `thread:${thread.root.id}`,
      at: thread.root.createdAt,
      thread,
    })),
    ...detail.activities.map((activity): TimelineEntry => ({
      kind: 'activity',
      key: `activity:${activity.id}`,
      at: activity.createdAt,
      activity,
    })),
    ...detail.runs.map((run): TimelineEntry => ({
      kind: 'run',
      key: `run:${run.id}`,
      at: run.createdAt,
      run,
    })),
  ];
  return entries.sort(
    (a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key),
  );
}

/**
 * The detail's newest activities and the older pages loaded on demand (§D), each once, oldest first. A page that
 * overlaps the detail (an activity arrived while paging) does not repeat it.
 */
export function mergeActivities(
  older: readonly IssueActivity[],
  newest: readonly IssueActivity[],
): IssueActivity[] {
  const byId = new Map<string, IssueActivity>();
  for (const activity of [...older, ...newest]) byId.set(activity.id, activity);
  return [...byId.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export type ActivityLabel =
  | 'created'
  | 'statusChanged'
  | 'priorityChanged'
  | 'executorChanged'
  | 'ownerChanged'
  | 'titleChanged'
  | 'descriptionChanged'
  | 'runDeferredBlocked'
  | 'dependencyChanged'
  | 'labelsChanged'
  | 'proposalDecided'
  | 'projectChanged'
  | 'parentChanged'
  | 'stageChanged'
  | 'datesChanged'
  // Phase 1 iteration 2 (§M)
  | 'prLinked'
  | 'prUnlinked'
  | 'prMerged'
  | 'approvalRequested'
  | 'approvalApproved'
  | 'approvalRejected'
  | 'approvalSelf'
  | 'approvalNoApprover'
  | 'threadResolved'
  | 'threadUnresolved'
  | 'executionModeChanged'
  | 'envChanged'
  | 'skillsChanged'
  | 'intakeConfirmed'
  | 'intakeReverted'
  // Phase 1 iteration 3 (§J)
  | 'knowledgeProposed'
  | 'knowledgeUpdated'
  | 'deliveryAccepted'
  | 'changesRequested'
  // Phase 1 iteration 4 (§B, §C)
  | 'processSelected'
  | 'designProposed'
  | 'designApproved'
  | 'designChangesRequested'
  | 'designSkipped'
  | 'retrospectiveDone'
  // NP-85
  | 'prMergeRequested'
  // NP-78
  | 'attachmentAdded'
  | 'attachmentRemoved'
  // Phase 2 signals
  | 'signalReceived'
  | 'signalSuppressed'
  | 'signalResolved'
  | 'updated';

/** Iteration 2 actions are matched exactly (snake case, as the contract spells them) before the keyword rules. */
const EXACT_LABELS: Readonly<Record<string, ActivityLabel>> = {
  pr_linked: 'prLinked',
  pr_unlinked: 'prUnlinked',
  pr_merged: 'prMerged',
  approval_requested: 'approvalRequested',
  approval_approved: 'approvalApproved',
  approval_rejected: 'approvalRejected',
  approval_self: 'approvalSelf',
  approval_no_approver: 'approvalNoApprover',
  thread_resolved: 'threadResolved',
  thread_unresolved: 'threadUnresolved',
  execution_mode_changed: 'executionModeChanged',
  env_changed: 'envChanged',
  skills_changed: 'skillsChanged',
  intake_confirmed: 'intakeConfirmed',
  intake_reverted: 'intakeReverted',
  knowledge_proposed: 'knowledgeProposed',
  knowledge_updated: 'knowledgeUpdated',
  delivery_accepted: 'deliveryAccepted',
  changes_requested: 'changesRequested',
  process_selected: 'processSelected',
  design_proposed: 'designProposed',
  design_approved: 'designApproved',
  design_changes_requested: 'designChangesRequested',
  design_skipped: 'designSkipped',
  retrospective_done: 'retrospectiveDone',
  pr_merge_requested: 'prMergeRequested',
  attachment_added: 'attachmentAdded',
  attachment_removed: 'attachmentRemoved',
  signal_received: 'signalReceived',
  signal_suppressed: 'signalSuppressed',
  signal_resolved: 'signalResolved',
};

/** Labels whose details carry a status change to show as badges. */
export const STATUS_CHANGE_LABELS: ReadonlySet<ActivityLabel> = new Set([
  'statusChanged',
  'approvalRequested',
  'approvalApproved',
  'approvalRejected',
  'approvalSelf',
  'approvalNoApprover',
]);

/**
 * Maps a server activity `action` to a locale label. The Phase 0 action vocabulary is not fixed by the protocol, so
 * the match is by keyword (`status.changed`, `issue.statusChanged`, `status_change` all read as a status change).
 */
export function activityLabel(action: string): ActivityLabel {
  const exact = EXACT_LABELS[action];
  if (exact) return exact;
  const normalized = action.toLowerCase().replace(/[^a-z]/gu, '');
  // Iteration 1 actions (§D): a run held back by open blockers, dependencies, labels, proposals and the new fields.
  if (normalized.includes('deferred')) return 'runDeferredBlocked';
  if (normalized.includes('dependenc')) return 'dependencyChanged';
  if (normalized.includes('proposal')) return 'proposalDecided';
  if (normalized.includes('label')) return 'labelsChanged';
  if (normalized.includes('project')) return 'projectChanged';
  if (normalized.includes('parent')) return 'parentChanged';
  if (normalized.includes('stage')) return 'stageChanged';
  if (/startdate|duedate|dates/u.test(normalized)) return 'datesChanged';
  if (normalized.includes('status')) return 'statusChanged';
  if (normalized.includes('priority')) return 'priorityChanged';
  if (normalized.includes('executor') || normalized.includes('assign')) {
    return 'executorChanged';
  }
  if (normalized.includes('owner')) return 'ownerChanged';
  if (normalized.includes('title')) return 'titleChanged';
  if (normalized.includes('description')) return 'descriptionChanged';
  if (normalized.includes('create')) return 'created';
  return 'updated';
}

/** Reads `{ from, to }` string details from the loosely shaped activity payload. */
export function activityChange(
  details: Record<string, unknown> | null | undefined,
): { readonly from: string | null; readonly to: string | null } {
  const pick = (...names: string[]): string | null => {
    for (const name of names) {
      const value = details?.[name];
      if (typeof value === 'string' && value) return value;
    }
    return null;
  };
  return {
    from: pick('from', 'fromStatus', 'previous', 'old'),
    to: pick('to', 'toStatus', 'next', 'new'),
  };
}

/** First line of a comment as plain text, for the collapsed header of a resolved thread. */
export function commentSnippet(content: string, max = 120): string {
  const text = content
    .replace(/\[@([^\]]*)\]\(mention:\/\/[^)]+\)/gu, '@$1')
    .replace(/[`*_>#~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
