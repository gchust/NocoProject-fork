import type { ExecutorRef } from '../../types.js';
import type {
  PmExecutorInput,
  PmIssueRef,
  PmOperationType,
  PmPlan,
  PmPlanEdit,
  PmPlanRow,
  PmPlanRowFlag,
} from '../../types-pm.js';

/**
 * An operation plan as pure data (`protocol-pm-assistant.md` §4, NP-185): the rows with the member's unsaved edits
 * applied, the task tree the `issue.create` rows form, which rows other rows depend on (those cannot be removed),
 * the field changes of an update, and what needs a confirmation before executing.
 */

export interface PmRowEdit {
  readonly params?: unknown;
  readonly removed?: boolean;
}

export type PmPlanEdits = ReadonlyMap<number, PmRowEdit>;

export interface PmRowView {
  readonly row: PmPlanRow;
  /** The params with the member's edit applied. */
  readonly params: Record<string, unknown>;
  readonly removed: boolean;
  /** Nesting of an `issue.create` row under the created parent rows, 0 otherwise. */
  readonly depth: number;
  readonly edited: boolean;
}

export const EDITABLE_STATUSES: ReadonlySet<PmPlan['status']> = new Set([
  'pending',
  'failed',
]);

export function isPlanEditable(plan: PmPlan): boolean {
  return EDITABLE_STATUSES.has(plan.status);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function refOf(value: unknown): string | null {
  const record = asRecord(value);
  return typeof record.ref === 'string' ? record.ref : null;
}

/** The refs a row's params point at: its parent, what blocks it, the issue it changes or comments on. */
export function refsUsedBy(params: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const key of ['parent', 'issue', 'blockedBy']) {
    const value = params[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      const ref = refOf(item);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

export function rowViews(plan: PmPlan, edits: PmPlanEdits): PmRowView[] {
  const bySeq = [...plan.rows].sort((a, b) => a.seq - b.seq);
  const depthByRef = new Map<string, number>();
  return bySeq.map((row) => {
    const edit = edits.get(row.seq);
    const params = asRecord(edit?.params ?? row.params);
    const removed = edit?.removed ?? row.status === 'removed';
    let depth = 0;
    if (row.type === 'issue.create') {
      const parentRef = refOf(params.parent);
      depth = parentRef ? (depthByRef.get(parentRef) ?? -1) + 1 : 0;
      if (row.ref) depthByRef.set(row.ref, depth);
    }
    return {
      row,
      params,
      removed,
      depth,
      edited: edit !== undefined,
    };
  });
}

/** Refs that a row still in the plan points at: removing their row would leave that row dangling. */
export function referencedRefs(
  views: readonly PmRowView[],
): ReadonlySet<string> {
  const used = new Set<string>();
  for (const view of views) {
    if (view.removed) continue;
    for (const ref of refsUsedBy(view.params)) used.add(ref);
  }
  return used;
}

export function canRemove(
  view: PmRowView,
  referenced: ReadonlySet<string>,
): boolean {
  return !view.row.ref || !referenced.has(view.row.ref);
}

/** The PATCH body for the member's edits (§4.4), or null when there are none. */
export function planEdit(plan: PmPlan, edits: PmPlanEdits): PmPlanEdit | null {
  if (edits.size === 0) return null;
  return {
    revision: plan.revision,
    ops: [...edits.entries()]
      .sort(([a], [b]) => a - b)
      .map(([seq, edit]) => ({
        seq,
        ...(edit.params === undefined ? {} : { params: edit.params }),
        ...(edit.removed === undefined ? {} : { removed: edit.removed }),
      })),
  };
}

/** How a reference to an issue reads: another row by its title, or the issue's identifier as given. */
export function issueRefLabel(
  value: unknown,
  views: readonly PmRowView[],
): string {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (typeof record.issue === 'string') return record.issue;
  const ref = refOf(value);
  if (!ref) return '—';
  const target = views.find((view) => view.row.ref === ref);
  const title = target
    ? (target.params.title ?? target.params.name)
    : undefined;
  return typeof title === 'string' && title ? title : ref;
}

export function isIssueRef(value: unknown): value is PmIssueRef {
  const record = asRecord(value);
  return typeof record.issue === 'string' || typeof record.ref === 'string';
}

export interface FieldChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** An update's fields as "was → becomes", the current values taken from the row's baseline. */
export function updateChanges(view: PmRowView): FieldChange[] {
  const set = asRecord(view.params.set);
  const baseline = view.row.baseline ?? {};
  return Object.entries(set).map(([field, to]) => ({
    field,
    from: baseline[field],
    to,
  }));
}

/** Flags that change what happens beyond the plan's own objects, shown loudly and confirmed before executing. */
export const WARNING_FLAGS: ReadonlySet<PmPlanRowFlag> = new Set([
  'startsRun',
  'terminal',
  'ownerChange',
]);

/** The rows (still in the plan) that ask for a confirmation before the plan is executed. */
export function rowsToConfirm(views: readonly PmRowView[]): PmRowView[] {
  return views.filter(
    (view) =>
      !view.removed && view.row.flags.some((flag) => WARNING_FLAGS.has(flag)),
  );
}

/** Row error codes with their own wording under `np.pmAssistant.plan.errors`; others show the server's message. */
const KNOWN_ERRORS = new Set([
  'STALE_TARGET',
  'INVALID_REF',
  'FORBIDDEN',
  'NOT_FOUND',
  'PROCESS_LOCKED',
  'INVALID_TRANSITION',
  'CONVERSATION_NOT_ISSUE',
  'UNSUPPORTED_DECISION',
  'DEPENDENCY_CYCLE',
]);

export function rowErrorKey(code: string | undefined): string | null {
  return code && KNOWN_ERRORS.has(code)
    ? `np.pmAssistant.plan.errors.${code}`
    : null;
}

export function toExecutorRef(input: unknown): ExecutorRef {
  const record = asRecord(input);
  if (
    (record.type === 'user' || record.type === 'agent') &&
    typeof record.id === 'string'
  ) {
    return { type: record.type, id: record.id };
  }
  return { type: 'none', id: null };
}

export function fromExecutorRef(ref: ExecutorRef): PmExecutorInput {
  return ref.type === 'none' || !ref.id
    ? { type: 'none' }
    : { type: ref.type, id: ref.id };
}

/** Whole hours (at least 1) until the plan expires, or 0 once it has. */
export function hoursLeft(expiresAt: string, now = Date.now()): number {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 3_600_000));
}

/** Row types with fields a member may change on the card; dependencies and status moves are kept or removed whole. */
export const EDITABLE_TYPES: ReadonlySet<PmOperationType> = new Set([
  'issue.create',
  'issue.update',
  'comment.create',
  'decision.resolve',
  'project.create',
]);
