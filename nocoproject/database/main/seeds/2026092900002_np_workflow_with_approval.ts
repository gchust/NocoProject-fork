import { defineSeed, type SeedDefinition } from '@nocobase/db';

// The second, non-default workflow template "软件开发（验收审批）" (docs/phase1/iteration-2-contract.md §A): the default
// template plus an approval on `in_review → done` (actors user; approvers the project lead and the issue owner).
// Projects opt in with `PATCH /np/projects/:id { workflowId: 'software-with-approval' }`. Idempotent: an existing row
// with this id (possibly edited) is left alone.
//
// The approval rule is @temporary(nocobase-official): 待替换为 NocoBase 官方 工作流审批.
//
// Self-contained on purpose: the definition is spelled out here rather than imported from server/modules.
const WORKFLOW_ID = 'software-with-approval';

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
    // The difference from the default template: accepting a review needs the project lead or the owner.
    {
      from: 'in_review',
      to: 'done',
      actors: ['user'],
      approval: { approvers: ['projectLead', 'owner'] },
    },
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
  name: '2026092900002_np_workflow_with_approval',

  async run({ query }) {
    const existing = await query
      .selectFrom('workflowTemplates')
      .select('id')
      .where('id', '=', WORKFLOW_ID)
      .executeTakeFirst();
    if (existing) return;
    const now = new Date();
    await query
      .insertInto('workflowTemplates')
      .values({
        id: WORKFLOW_ID,
        name: '软件开发（验收审批）',
        isDefault: false,
        // JSON columns hold serialized text, like every NocoProject JSON write.
        definition: JSON.stringify(definition),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  },
});

export default seed;
