import { defineSeed, type SeedDefinition } from '@nocobase/db';

// The default "软件开发" workflow template (docs/phase1/iteration-1-contract.md §C). Iteration 1 only reads it; a
// project without a workflowId uses it. Idempotent: an existing default workflow (possibly edited) is left alone.
//
// Self-contained on purpose: the definition is spelled out here rather than imported from server/modules.
const DEFAULT_WORKFLOW_ID = 'default';

const definition = {
  statuses: [
    {
      key: 'backlog',
      name: 'Backlog',
      category: 'unstarted',
      color: 'gray',
      builtIn: true,
    },
    {
      key: 'todo',
      name: 'Todo',
      category: 'unstarted',
      color: 'blue',
      builtIn: true,
    },
    {
      key: 'in_progress',
      name: 'In Progress',
      category: 'started',
      color: 'yellow',
      builtIn: true,
    },
    {
      key: 'in_review',
      name: 'In Review',
      category: 'started',
      color: 'purple',
      builtIn: true,
    },
    {
      key: 'blocked',
      name: 'Blocked',
      category: 'started',
      color: 'red',
      builtIn: true,
    },
    {
      key: 'done',
      name: 'Done',
      category: 'done',
      color: 'green',
      builtIn: true,
    },
    {
      key: 'cancelled',
      name: 'Cancelled',
      category: 'closed',
      color: 'gray',
      builtIn: true,
    },
  ],
  transitions: [
    { from: '*', to: '*', actors: ['user'] },
    { from: 'todo', to: 'in_progress', actors: ['agent'] },
    { from: 'blocked', to: 'in_progress', actors: ['agent'] },
    { from: 'in_progress', to: 'in_review', actors: ['agent'] },
    { from: 'in_progress', to: 'blocked', actors: ['agent'] },
    { from: 'in_progress', to: 'todo', actors: ['system'] },
    { from: '*', to: 'done', actors: ['system'] },
  ],
  childBatchDoneWakesParentExecutor: true,
};

const seed: SeedDefinition = defineSeed({
  name: '2026092800002_np_default_workflow',

  async run({ query }) {
    const existing = await query
      .selectFrom('workflowTemplates')
      .select('id')
      .where('isDefault', '=', true)
      .executeTakeFirst();
    if (existing) return;
    const now = new Date();
    await query
      .insertInto('workflowTemplates')
      .values({
        id: DEFAULT_WORKFLOW_ID,
        name: '软件开发',
        isDefault: true,
        // JSON columns hold serialized text, like every NocoProject JSON write.
        definition: JSON.stringify(definition),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  },
});

export default seed;
