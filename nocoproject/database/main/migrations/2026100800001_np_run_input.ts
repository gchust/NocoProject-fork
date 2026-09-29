// NP-114: opt in per run, so already-running/older daemons retain queued delivery.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const migration: MigrationDefinition = defineMigration({
  name: '2026100800001_np_run_input',
  async up({ builder }) {
    await builder.alterCollection('runs', (table) => {
      table.boolean('acceptsInput').notNull().defaultTo(false);
    });
  },
  async down({ builder }) {
    await builder.alterCollection('runs', (table) => {
      table.dropFields('acceptsInput');
    });
  },
});
export default migration;
