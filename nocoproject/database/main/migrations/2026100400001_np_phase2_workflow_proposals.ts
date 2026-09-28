// NocoProject Phase 2 workflow template proposals (NP-77 方案 §4, stage 2).
//
// workflowTemplates: `revision` (starts at 1, + 1 each time a new definition takes effect) and `isSystem` (the seeded
// templates, which may only be copied; the seed `2026100400002_np_system_workflows` sets it).
// workflowTemplateRevisions: a snapshot of every definition that took effect, unique per (template, revision).
// workflowProposals: an agent's proposed definition for an existing template (`templateId`) or for a copy of one
// (`copyFromId`; `templateId` is filled with the new template once accepted), decided by an owner/admin.
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import {
  defineMigration,
  type MigrationContext,
  type MigrationDefinition,
} from '@nocobase/db';

const ID = { length: 32 } as const;
const USER_ID = { length: 64 } as const;

type Builder = MigrationContext['builder'];

async function createRevisions(builder: Builder): Promise<void> {
  await builder.createCollection('workflowTemplateRevisions', (table) => {
    table.string('id', ID).primary();
    table.string('templateId', ID).notNull();
    table.integer('revision').notNull();
    table.string('name', { length: 255 }).notNull();
    table.json('definition').notNull();
    table.string('proposalId', ID).nullable();
    table.text('note').nullable();
    table.string('createdByType', { length: 16 }).notNull();
    table.string('createdById', USER_ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.unique(['templateId', 'revision'], {
      name: 'np_workflow_template_revisions_unique',
    });
  });
}

async function createProposals(builder: Builder): Promise<void> {
  await builder.createCollection('workflowProposals', (table) => {
    table.string('id', ID).primary();
    table.string('templateId', ID).nullable();
    table.string('copyFromId', ID).nullable();
    table.string('name', { length: 255 }).nullable();
    table.json('definition').notNull();
    table.json('baseDefinition').notNull();
    table.string('baseName', { length: 255 }).notNull();
    table.integer('baseRevision').notNull();
    table.text('reason').notNull();
    table.string('proposedByAgentId', ID).notNull();
    table.string('sourceRunId', ID).nullable();
    table.string('sourceIssueId', ID).nullable();
    table.string('status', { length: 16 }).notNull().defaultTo('pending');
    table.string('decidedById', USER_ID).nullable();
    table.datetimeTz('decidedAt').nullable();
    table.text('comment').nullable();
    table.integer('resultRevision').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index(['status', 'templateId'], {
      name: 'np_workflow_proposals_status_template_idx',
    });
    table.index(['sourceRunId', 'status'], {
      name: 'np_workflow_proposals_run_status_idx',
    });
  });
}

const migration: MigrationDefinition = defineMigration({
  name: '2026100400001_np_phase2_workflow_proposals',

  async up({ builder }) {
    await builder.alterCollection('workflowTemplates', (table) => {
      table.integer('revision').notNull().defaultTo(1);
      table.boolean('isSystem').notNull().defaultTo(false);
    });
    await createRevisions(builder);
    await createProposals(builder);
  },

  async down({ builder }) {
    await builder.dropCollection('workflowProposals');
    await builder.dropCollection('workflowTemplateRevisions');
    await builder.alterCollection('workflowTemplates', (table) => {
      table.dropFields('revision', 'isSystem');
    });
  },
});

export default migration;
