// NocoProject Phase 2 workflow stage actions (NP-77 方案 §3, §6).
//
// executorProposals: `proposedByAgentId` becomes nullable (workflow suggestions have no proposing agent), plus
// `source` ('agent' | 'workflow', default agent) and `stageStatusKey` (the status that produced a workflow
// suggestion). `status` gains the value 'superseded', which fits the existing column.
// issueChecklistItems: the checklist snapshot generated when an issue enters a status with a `checklist` action, one
// row per item, unique per (issue, status, item).
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
const STATUS_KEY = { length: 32 } as const;

type Builder = MigrationContext['builder'];

async function alterProposals(builder: Builder): Promise<void> {
  await builder.alterField('executorProposals', 'proposedByAgentId', {
    type: 'string',
    ...ID,
    nullable: true,
  });
  await builder.alterCollection('executorProposals', (table) => {
    table.string('source', { length: 16 }).notNull().defaultTo('agent');
    table.string('stageStatusKey', STATUS_KEY).nullable();
  });
}

async function createChecklistItems(builder: Builder): Promise<void> {
  await builder.createCollection('issueChecklistItems', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('statusKey', STATUS_KEY).notNull();
    table.string('itemKey', { length: 64 }).notNull();
    table.text('label').notNull();
    table.boolean('required').notNull().defaultTo(false);
    table.integer('position').notNull().defaultTo(0);
    table.string('checkedByType', { length: 16 }).nullable();
    table.string('checkedById', USER_ID).nullable();
    table.datetimeTz('checkedAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['issueId', 'statusKey', 'itemKey'], {
      name: 'np_issue_checklist_items_unique',
    });
  });
}

const migration: MigrationDefinition = defineMigration({
  name: '2026100200001_np_phase2_stage_actions',

  async up({ builder }) {
    await alterProposals(builder);
    await createChecklistItems(builder);
  },

  async down({ builder, query }) {
    await builder.dropCollection('issueChecklistItems');
    // Workflow suggestions have no proposing agent and cannot survive the NOT NULL constraint below.
    await query
      .deleteFrom('executorProposals')
      .where('source', '=', 'workflow')
      .execute();
    await builder.alterCollection('executorProposals', (table) => {
      table.dropFields('source', 'stageStatusKey');
    });
    await builder.alterField('executorProposals', 'proposedByAgentId', {
      type: 'string',
      ...ID,
      nullable: false,
    });
  },
});

export default migration;
