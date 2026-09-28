// NocoProject issue attachments (NP-78, docs/phase1/protocol-iteration-4.md §"附件").
//
// npFiles: the nine columns `@nocobase/app-plugin-file` requires of a file Collection (it writes them on upload and
// reads `disk` / `key` to serve the bytes, so a later move to another disk keeps old rows readable), plus
// `uploadedById` (stamped by the upload Policy from the signed-in user) and `issueId` (null until the file is
// attached to an issue; a file belongs to at most one issue).
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const ID = { length: 32 } as const;
const USER_ID = { length: 64 } as const;

const migration: MigrationDefinition = defineMigration({
  name: '2026100400001_np_attachments',

  async up({ builder }) {
    await builder.createCollection('npFiles', (table) => {
      table.uuid('id').primary().notNull();
      table.string('disk', { length: 255 }).notNull();
      table.text('key').notNull();
      table.text('filename').notNull();
      table.string('ext', { length: 32 }).notNull();
      table.string('mimeType', { length: 255 }).notNull();
      table.bigInt('size').notNull();
      table.string('uploadedById', USER_ID).nullable();
      table.string('issueId', ID).nullable();
      table.datetimeTz('createdAt').notNull();
      table.datetimeTz('updatedAt').notNull();
      table.index('issueId', { name: 'np_files_issue_idx' });
    });
  },

  async down({ builder }) {
    await builder.dropCollection('npFiles');
  },
});

export default migration;
