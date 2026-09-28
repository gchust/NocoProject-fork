// NocoProject Phase 1 iteration 4 schema (docs/phase1/iteration-4-contract.md §A).
//
// issues: `process` ('direct' | 'design_first', default direct), `designApprovedAt`, `designApprovedById`.
// agents: `kind` ('coder' | 'manager', default coder), `reasoningEffort` (nullable).
// comments.kind gains the value 'proposal' and systemSettings.settings gains keys; neither needs a column change.
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import {
  defineMigration,
  type MigrationContext,
  type MigrationDefinition,
} from '@nocobase/db';

const USER_ID = { length: 64 } as const;

type Builder = MigrationContext['builder'];

async function addColumns(builder: Builder): Promise<void> {
  await builder.alterCollection('issues', (table) => {
    table.string('process', { length: 16 }).notNull().defaultTo('direct');
    table.datetimeTz('designApprovedAt').nullable();
    table.string('designApprovedById', USER_ID).nullable();
  });
  await builder.alterCollection('agents', (table) => {
    table.string('kind', { length: 16 }).notNull().defaultTo('coder');
    table.string('reasoningEffort', { length: 16 }).nullable();
  });
}

async function dropColumns(builder: Builder): Promise<void> {
  await builder.alterCollection('agents', (table) => {
    table.dropFields('kind', 'reasoningEffort');
  });
  await builder.alterCollection('issues', (table) => {
    table.dropFields('process', 'designApprovedAt', 'designApprovedById');
  });
}

const migration: MigrationDefinition = defineMigration({
  name: '2026100100001_np_phase1_iter4',

  async up({ builder }) {
    await addColumns(builder);
  },

  async down({ builder }) {
    await dropColumns(builder);
  },
});

export default migration;
