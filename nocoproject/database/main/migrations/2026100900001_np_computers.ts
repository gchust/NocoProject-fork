// NP-150: computer credentials. Each row is one computer's daemon credential: an API key of the non-session
// `np-computer` configuration (the `apikey` row belongs to the API Keys plugin; `keyId` points at it), bound to the
// daemon id the computer first registered with, and revocable on its own.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const migration: MigrationDefinition = defineMigration({
  name: '2026100900001_np_computers',
  async up({ builder }) {
    await builder.createCollection('npComputers', (table) => {
      table.string('id', { length: 32 }).primary();
      table.string('ownerUserId', { length: 64 }).notNull();
      table.string('name', { length: 255 }).notNull();
      table.string('keyId', { length: 255 }).notNull();
      table.string('keyStart', { length: 32 }).nullable();
      // sha256 of the secret: only to tell a revoked credential ("add the computer again") from an unknown one.
      table.string('keyHash', { length: 64 }).notNull();
      table.string('daemonId', { length: 128 }).nullable();
      table.datetimeTz('lastUsedAt').nullable();
      table.datetimeTz('createdAt').notNull();
      table.datetimeTz('revokedAt').nullable();
      table.string('revokedById', { length: 64 }).nullable();
      table.unique(['keyId'], { name: 'np_computers_key_unique' });
      table.unique(['keyHash'], { name: 'np_computers_key_hash_unique' });
      table.index(['ownerUserId'], { name: 'np_computers_owner_idx' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('npComputers');
  },
});

export default migration;
