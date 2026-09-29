// NocoProject: the merge-check queue behind the GitHub `conflict` signal.
//
// pullRequests: `mergeCheckAfter` (nullable) — when set, the sweeper reads the pull request from GitHub at or after
// that time, because GitHub computes mergeability lazily and sends no webhook when a push to the base branch leaves a
// pull request conflicting; `mergeCheckAttempts` counts the reads while GitHub is still computing.
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const migration: MigrationDefinition = defineMigration({
  name: '2026100900001_np_pr_merge_checks',

  async up({ builder }) {
    await builder.alterCollection('pullRequests', (table) => {
      table.datetimeTz('mergeCheckAfter').nullable();
      table.integer('mergeCheckAttempts').notNull().defaultTo(0);
      table.index('mergeCheckAfter', {
        name: 'np_pull_requests_merge_check_after_idx',
      });
    });
  },

  async down({ builder }) {
    await builder.alterCollection('pullRequests', (table) => {
      table.dropIndex('np_pull_requests_merge_check_after_idx');
      table.dropFields('mergeCheckAfter', 'mergeCheckAttempts');
    });
  },
});

export default migration;
