import type { StatusCategory, WorkflowStatusDefinition } from '../types.js';
import type { ApproverRole } from '../types-iter2.js';
import type {
  WorkflowDefinitionV3,
  WorkflowTransitionV3,
} from '../types-iter3.js';

/**
 * The read-only picture of a workflow template (§F): the status line with its side branches, the transition matrix
 * (who may move an issue from each status to each other one, and where an approval is required), and the rules as
 * sentences. Pure functions over `definition`, so the page and the tests read the same thing.
 */

export type TransitionActorKind = 'user' | 'agent' | 'system';

const ACTOR_ORDER: readonly TransitionActorKind[] = ['user', 'agent', 'system'];

/** Statuses that sit beside the main line: closed ones (cancelled) and the built-in `blocked` detour. */
export function isSideStatus(status: WorkflowStatusDefinition): boolean {
  return status.category === 'closed' || status.key === 'blocked';
}

const CATEGORY_RANK: Readonly<Record<StatusCategory, number>> = {
  unstarted: 0,
  started: 1,
  done: 2,
  closed: 3,
};

/**
 * The main line (backlog → todo → in progress → in review → done) and the side branches (blocked, cancelled), each
 * in the definition's order within its category.
 */
export function workflowFlow(
  definition: Pick<WorkflowDefinitionV3, 'statuses'>,
): {
  readonly main: readonly WorkflowStatusDefinition[];
  readonly side: readonly WorkflowStatusDefinition[];
} {
  const indexed = definition.statuses.map((status, index) => ({
    status,
    index,
  }));
  const ordered = indexed
    .sort(
      (a, b) =>
        CATEGORY_RANK[a.status.category] - CATEGORY_RANK[b.status.category] ||
        a.index - b.index,
    )
    .map((entry) => entry.status);
  return {
    main: ordered.filter((status) => !isSideStatus(status)),
    side: ordered.filter(isSideStatus),
  };
}

export interface MatrixCell {
  readonly actors: readonly TransitionActorKind[];
  /** Approver roles when a matching transition requires an approval, else null. */
  readonly approval: readonly ApproverRole[] | null;
}

function matches(pattern: string, key: string): boolean {
  return pattern === '*' || pattern === key;
}

/** Who may move an issue from `from` to `to`: the union of every matching transition (`*` matches any status). */
export function transitionCell(
  transitions: readonly WorkflowTransitionV3[],
  from: string,
  to: string,
): MatrixCell {
  const actors = new Set<TransitionActorKind>();
  const approvers = new Set<ApproverRole>();
  let approval = false;
  for (const transition of transitions) {
    if (!matches(transition.from, from) || !matches(transition.to, to)) {
      continue;
    }
    for (const actor of transition.actors) actors.add(actor);
    if (transition.approval) {
      approval = true;
      for (const role of transition.approval.approvers) approvers.add(role);
    }
  }
  return {
    actors: ACTOR_ORDER.filter((actor) => actors.has(actor)),
    approval: approval ? [...approvers] : null,
  };
}

export interface TransitionMatrix {
  readonly keys: readonly string[];
  readonly rows: readonly {
    readonly from: string;
    readonly cells: readonly (MatrixCell & { readonly to: string })[];
  }[];
}

/** Rows are "from", columns "to", in flow order; the diagonal (no move) is left empty. */
export function transitionMatrix(
  definition: WorkflowDefinitionV3,
): TransitionMatrix {
  const { main, side } = workflowFlow(definition);
  const keys = [...main, ...side].map((status) => status.key);
  return {
    keys,
    rows: keys.map((from) => ({
      from,
      cells: keys.map((to) =>
        from === to
          ? { to, actors: [], approval: null }
          : { to, ...transitionCell(definition.transitions, from, to) },
      ),
    })),
  };
}

export type WorkflowRule =
  | {
      readonly kind: 'transition';
      readonly from: string;
      readonly to: string;
      readonly actors: readonly TransitionActorKind[];
      readonly approval: readonly ApproverRole[] | null;
    }
  | { readonly kind: 'childBatchDone'; readonly enabled: boolean };

/** The definition as a list of rules: each declared transition, approvals first, then the sub-issue wake-up rule. */
export function workflowRules(
  definition: WorkflowDefinitionV3,
): WorkflowRule[] {
  const transitions: WorkflowRule[] = definition.transitions
    .map((transition, index) => ({ transition, index }))
    .sort(
      (a, b) =>
        Number(Boolean(b.transition.approval)) -
          Number(Boolean(a.transition.approval)) || a.index - b.index,
    )
    .map(({ transition }) => ({
      kind: 'transition' as const,
      from: transition.from,
      to: transition.to,
      actors: ACTOR_ORDER.filter((actor) => transition.actors.includes(actor)),
      approval: transition.approval ? [...transition.approval.approvers] : null,
    }));
  return [
    ...transitions,
    {
      kind: 'childBatchDone',
      enabled: definition.childBatchDoneWakesParentExecutor,
    },
  ];
}

/** Category → token classes for a status node, so the flow follows light and dark themes. */
export const CATEGORY_NODE_CLASS: Readonly<Record<StatusCategory, string>> = {
  unstarted: 'border-border bg-muted text-foreground',
  started: 'border-chart-3/60 bg-chart-3/15 text-foreground',
  done: 'border-chart-2/60 bg-chart-2/15 text-foreground',
  closed: 'border-dashed border-border bg-background text-muted-foreground',
};
