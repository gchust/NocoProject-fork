import { defineSeed, type SeedDefinition } from '@nocobase/db';

// Iteration 4 (docs/phase1/iteration-4-contract.md §A, §B): the design-first statuses `analysis` (after todo) and
// `proposal_review` (after analysis), both category started, and their transitions, added to the default template
// (the row marked default, and the seeded `default` row) and to the approval template `software-with-approval`.
//
// Idempotent: a status whose key is already in a template is left alone, and a transition is added only when the
// template has no transition with the same from, to and actors. Edited templates keep their edits.
//
// `blocked → analysis` for agents is beyond the contract's list: without it an agent that blocked during analysis
// could only resume into in_progress, which the design gate refuses before approval.
//
// Self-contained on purpose: the statuses and transitions are spelled out here rather than imported from
// server/modules.
const TEMPLATE_IDS = ['default', 'software-with-approval'];

interface StatusDefinition {
  readonly key: string;
  readonly name: string;
  readonly category: string;
  readonly color: string;
  readonly builtIn: boolean;
}

interface TransitionDefinition {
  readonly from: string;
  readonly to: string;
  readonly actors: readonly string[];
}

interface Definition {
  statuses: StatusDefinition[];
  transitions: TransitionDefinition[];
  [key: string]: unknown;
}

const STATUSES: readonly { after: string; status: StatusDefinition }[] = [
  {
    after: 'todo',
    status: {
      key: 'analysis',
      name: 'Analysis',
      category: 'started',
      color: 'orange',
      builtIn: true,
    },
  },
  {
    after: 'analysis',
    status: {
      key: 'proposal_review',
      name: 'Proposal Review',
      category: 'started',
      color: 'purple',
      builtIn: true,
    },
  },
];

const TRANSITIONS: readonly TransitionDefinition[] = [
  { from: 'todo', to: 'analysis', actors: ['agent', 'user'] },
  { from: 'analysis', to: 'proposal_review', actors: ['agent', 'user'] },
  { from: 'proposal_review', to: 'analysis', actors: ['user', 'system'] },
  { from: 'proposal_review', to: 'in_progress', actors: ['system', 'user'] },
  { from: 'analysis', to: 'blocked', actors: ['agent', 'user'] },
  { from: 'proposal_review', to: 'blocked', actors: ['agent', 'user'] },
  { from: 'blocked', to: 'analysis', actors: ['agent'] },
];

function sameActors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((actor) => b.includes(actor));
}

/** Adds the missing statuses and transitions; returns whether anything changed. */
function extend(definition: Definition): boolean {
  let changed = false;
  for (const { after, status } of STATUSES) {
    if (definition.statuses.some((item) => item.key === status.key)) continue;
    const index = definition.statuses.findIndex((item) => item.key === after);
    definition.statuses.splice(
      index < 0 ? definition.statuses.length : index + 1,
      0,
      status,
    );
    changed = true;
  }
  for (const transition of TRANSITIONS) {
    const exists = definition.transitions.some(
      (item) =>
        item.from === transition.from &&
        item.to === transition.to &&
        sameActors(item.actors ?? [], transition.actors),
    );
    if (exists) continue;
    definition.transitions.push(transition);
    changed = true;
  }
  return changed;
}

function parse(value: unknown): Definition | null {
  const parsed: unknown =
    typeof value === 'string' ? JSON.parse(value) : (value ?? null);
  if (!parsed || typeof parsed !== 'object') return null;
  const definition = parsed as Partial<Definition>;
  if (
    !Array.isArray(definition.statuses) ||
    !Array.isArray(definition.transitions)
  )
    return null;
  return definition as Definition;
}

const seed: SeedDefinition = defineSeed({
  name: '2026100100002_np_iter4_workflow_statuses',

  async run({ query }) {
    const rows = await query
      .selectFrom('workflowTemplates')
      .select(['id', 'isDefault', 'definition'])
      .execute();
    for (const row of rows) {
      if (!row.isDefault && !TEMPLATE_IDS.includes(String(row.id))) continue;
      const definition = parse(row.definition);
      if (!definition || !extend(definition)) continue;
      await query
        .updateTable('workflowTemplates')
        // JSON columns hold serialized text, like every NocoProject JSON write.
        .set({ definition: JSON.stringify(definition), updatedAt: new Date() })
        .where('id', '=', row.id)
        .execute();
    }
  },
});

export default seed;
