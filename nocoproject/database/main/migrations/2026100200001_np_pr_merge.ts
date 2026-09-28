// NocoProject: merging pull requests from the issue page and the inbox (NP-85, docs/phase1/protocol-iteration-4.md).
//
// pullRequests: `ciRunUrl` (the head commit's latest GitHub Actions run) and `screenshotsUrl` (its `screenshots`
// artifact), both nullable, filled by the REST refresh.
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const migration: MigrationDefinition = defineMigration({
  name: '2026100200001_np_pr_merge',

  async up({ builder }) {
    await builder.alterCollection('pullRequests', (table) => {
      table.text('ciRunUrl').nullable();
      table.text('screenshotsUrl').nullable();
    });
  },

  async down({ builder }) {
    await builder.alterCollection('pullRequests', (table) => {
      table.dropFields('ciRunUrl', 'screenshotsUrl');
    });
  },
});

export default migration;
