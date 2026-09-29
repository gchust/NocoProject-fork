// NP-134: keep agent identities for historical comments and runs after deletion.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const migration: MigrationDefinition = defineMigration({
  name: '2026100700001_np_agent_deletion',
  async up({ builder }) {
    await builder.alterCollection('agents', (table) => {
      table.datetimeTz('deletedAt').nullable();
    });
  },
  async down({ builder }) {
    await builder.alterCollection('agents', (table) => {
      table.dropFields('deletedAt');
    });
  },
});

export default migration;
