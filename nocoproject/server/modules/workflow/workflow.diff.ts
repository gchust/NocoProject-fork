/**
 * The structured difference between two workflow definitions (NP-77 方案 §4): what the decider reads on a template
 * proposal card. Pure; the caller resolves agent names.
 *
 * - statuses by key: added, removed, name / color changes (key and category are fixed by validation), and `order`
 *   when the statuses both definitions have appear in a different order;
 * - transitions by `from → to`: several entries of the same pair merge (actors as a set, approvers as a set, null
 *   when none has an approval); added, removed, and actor / approver changes;
 * - actions per status as whole actions (canonical JSON, multiset): added and removed;
 * - `runExecutorAgents`: every `runExecutor` with an `agentId` in the new definition, highlighted separately because
 *   entering that status wakes the agent without the owner's confirmation; `isNew` when the base has no runExecutor
 *   of that agent on the same status.
 */
import type {
  StageAction,
  WorkflowDefinitionV5,
  WorkflowDiff,
  WorkflowDiffStatus,
  WorkflowDiffTransition,
  WorkflowTransitionDefinitionV2,
} from '../shared/protocol.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

function sameList(a: readonly string[] | null, b: readonly string[] | null) {
  return canonical(a) === canonical(b);
}

function mergedTransitions(
  definition: WorkflowDefinitionV5,
): Map<string, WorkflowDiffTransition> {
  const merged = new Map<
    string,
    { from: string; to: string; actors: Set<string>; approvers: Set<string> }
  >();
  for (const transition of definition.transitions as readonly WorkflowTransitionDefinitionV2[]) {
    const key = `${transition.from}\u0000${transition.to}`;
    const entry = merged.get(key) ?? {
      from: transition.from,
      to: transition.to,
      actors: new Set<string>(),
      approvers: new Set<string>(),
    };
    for (const actor of transition.actors) entry.actors.add(actor);
    for (const role of transition.approval?.approvers ?? [])
      entry.approvers.add(role);
    merged.set(key, entry);
  }
  return new Map(
    Array.from(merged, ([key, entry]) => [
      key,
      {
        from: entry.from,
        to: entry.to,
        actors: Array.from(entry.actors).sort(),
        approvers:
          entry.approvers.size > 0 ? Array.from(entry.approvers).sort() : null,
      },
    ]),
  );
}

function statusRef(status: WorkflowDefinitionV5['statuses'][number]) {
  return { key: status.key, name: status.name, category: status.category };
}

function statusDiff(
  base: WorkflowDefinitionV5,
  next: WorkflowDefinitionV5,
): WorkflowDiff['statuses'] {
  const before = new Map(base.statuses.map((status) => [status.key, status]));
  const after = new Map(next.statuses.map((status) => [status.key, status]));
  const added: WorkflowDiffStatus[] = [];
  const changed: Mutable<WorkflowDiff['statuses']['changed'][number]>[] = [];
  for (const status of next.statuses) {
    const previous = before.get(status.key);
    if (!previous) {
      added.push(statusRef(status));
      continue;
    }
    const change: Mutable<WorkflowDiff['statuses']['changed'][number]> = {
      key: status.key,
    };
    if (previous.name !== status.name)
      change.name = { from: previous.name, to: status.name };
    if (previous.color !== status.color)
      change.color = { from: previous.color, to: status.color };
    if (change.name || change.color) changed.push(change);
  }
  const removed = base.statuses
    .filter((status) => !after.has(status.key))
    .map(statusRef);
  const common = (definition: WorkflowDefinitionV5) =>
    definition.statuses
      .map((status) => status.key)
      .filter((key) => before.has(key) && after.has(key));
  const order = { from: common(base), to: common(next) };
  return canonical(order.from) === canonical(order.to)
    ? { added, removed, changed }
    : { added, removed, changed, order };
}

function transitionDiff(
  base: WorkflowDefinitionV5,
  next: WorkflowDefinitionV5,
): WorkflowDiff['transitions'] {
  const before = mergedTransitions(base);
  const after = mergedTransitions(next);
  const added: WorkflowDiffTransition[] = [];
  const changed: Mutable<WorkflowDiff['transitions']['changed'][number]>[] = [];
  for (const [key, transition] of after) {
    const previous = before.get(key);
    if (!previous) {
      added.push(transition);
      continue;
    }
    const change: Mutable<WorkflowDiff['transitions']['changed'][number]> = {
      from: transition.from,
      to: transition.to,
    };
    if (!sameList(previous.actors, transition.actors))
      change.actors = { from: previous.actors, to: transition.actors };
    if (!sameList(previous.approvers, transition.approvers))
      change.approvers = { from: previous.approvers, to: transition.approvers };
    if (change.actors || change.approvers) changed.push(change);
  }
  const removed = Array.from(before)
    .filter(([key]) => !after.has(key))
    .map(([, transition]) => transition);
  return { added, removed, changed };
}

/** Actions of `a` not matched one-for-one in `b`. */
function missingFrom(
  a: readonly StageAction[],
  b: readonly StageAction[],
): StageAction[] {
  const pool = b.map(canonical);
  const missing: StageAction[] = [];
  for (const action of a) {
    const index = pool.indexOf(canonical(action));
    if (index >= 0) pool.splice(index, 1);
    else missing.push(action);
  }
  return missing;
}

function actionDiff(
  base: WorkflowDefinitionV5,
  next: WorkflowDefinitionV5,
): WorkflowDiff['actions'] {
  const before = new Map(
    base.statuses.map((status) => [status.key, status.onEnter ?? []]),
  );
  const after = new Map(
    next.statuses.map((status) => [status.key, status.onEnter ?? []]),
  );
  const keys = [
    ...next.statuses.map((status) => status.key),
    ...base.statuses
      .map((status) => status.key)
      .filter((key) => !after.has(key)),
  ];
  return keys
    .map((statusKey) => {
      const old = before.get(statusKey) ?? [];
      const now = after.get(statusKey) ?? [];
      return {
        statusKey,
        added: missingFrom(now, old),
        removed: missingFrom(old, now),
      };
    })
    .filter((entry) => entry.added.length > 0 || entry.removed.length > 0);
}

function runExecutorAgents(
  definition: WorkflowDefinitionV5,
): { statusKey: string; agentId: string }[] {
  return definition.statuses.flatMap((status) =>
    (status.onEnter ?? []).flatMap((action) =>
      action.type === 'runExecutor' && action.agentId
        ? [{ statusKey: status.key, agentId: action.agentId }]
        : [],
    ),
  );
}

/** Agent ids named by `runExecutor` actions of a definition (for name lookups). */
export function runExecutorAgentIds(
  definition: WorkflowDefinitionV5,
): string[] {
  return Array.from(
    new Set(runExecutorAgents(definition).map((entry) => entry.agentId)),
  );
}

export function diffWorkflows(input: {
  readonly base: WorkflowDefinitionV5;
  readonly next: WorkflowDefinitionV5;
  readonly baseName: string;
  /** The proposed name; null keeps the base name. */
  readonly nextName: string | null;
  readonly agentNames: ReadonlyMap<string, string>;
}): WorkflowDiff {
  const { base, next } = input;
  const statuses = statusDiff(base, next);
  const transitions = transitionDiff(base, next);
  const actions = actionDiff(base, next);
  const existing = new Set(
    runExecutorAgents(base).map(
      (entry) => `${entry.statusKey}\u0000${entry.agentId}`,
    ),
  );
  const diff: Mutable<WorkflowDiff> = {
    statuses,
    transitions,
    actions,
    runExecutorAgents: runExecutorAgents(next).map((entry) => ({
      ...entry,
      agentName: input.agentNames.get(entry.agentId) ?? null,
      isNew: !existing.has(`${entry.statusKey}\u0000${entry.agentId}`),
    })),
    empty: false,
  };
  if (
    base.childBatchDoneWakesParentExecutor !==
    next.childBatchDoneWakesParentExecutor
  )
    diff.childBatchDoneWakesParentExecutor = {
      from: base.childBatchDoneWakesParentExecutor,
      to: next.childBatchDoneWakesParentExecutor,
    };
  if (input.nextName !== null && input.nextName !== input.baseName)
    diff.name = { from: input.baseName, to: input.nextName };
  diff.empty =
    statuses.added.length +
      statuses.removed.length +
      statuses.changed.length +
      (statuses.order ? 1 : 0) +
      transitions.added.length +
      transitions.removed.length +
      transitions.changed.length +
      actions.length ===
      0 &&
    !diff.childBatchDoneWakesParentExecutor &&
    !diff.name;
  return diff;
}
