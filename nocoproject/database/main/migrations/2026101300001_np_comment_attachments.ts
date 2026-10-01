// NP-214 comment attachments.
//
// npFiles.commentId: the comment a file belongs to (at most one). Attaching it to a comment also sets `issueId` to
// the comment's issue, so reading follows the issue's visibility; the issue's own attachments are the rows of the
// issue whose `commentId` is null.
// npFiles.uploadedByRunId: the run that uploaded the file through the agent API (`uploadedById` is then null); only
// that run may attach it to a comment.
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const ID = { length: 32 } as const;

const migration: MigrationDefinition = defineMigration({
  name: '2026101300001_np_comment_attachments',

  async up({ builder }) {
    await builder.alterCollection('npFiles', (table) => {
      table.string('commentId', ID).nullable();
      table.string('uploadedByRunId', ID).nullable();
      table.index('commentId', { name: 'np_files_comment_idx' });
    });
  },

  async down({ builder }) {
    // Two steps: within one alteration the column would go first, taking the index with it.
    await builder.alterCollection('npFiles', (table) => {
      table.dropIndex('np_files_comment_idx');
    });
    await builder.alterCollection('npFiles', (table) => {
      table.dropFields('commentId', 'uploadedByRunId');
    });
  },
});

export default migration;
