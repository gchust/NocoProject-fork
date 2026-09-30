// @vitest-environment node
/**
 * NP-114: the run input migration adds `runs.accepts_input` and rolls back alone. It runs on an unmigrated schema so
 * the migration is its own batch; a fully migrated database holds it in one batch with irreversible migrations.
 */
import { createMigrator } from '@nocobase/db';
import { afterAll, expect, it } from 'vitest';

import { MIGRATIONS_DIR, openNpTestDatabase } from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_run_input_migration', {
  migrate: false,
});
const skipped = 'skip' in opened;
if (skipped) console.warn(opened.skip);
const db = opened as Exclude<typeof opened, { skip: string }>;
afterAll(() => (skipped ? undefined : db.close()));

const NAME = '2026100800001_np_run_input';

it.skipIf(skipped)(
  'rolls the input capability column down and up',
  async () => {
    const migrator = createMigrator({
      database: db.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });
    await migrator.upTo('2026100800001_np_knowledge_tree');
    expect(await db.knex.schema.hasColumn('runs', 'accepts_input')).toBe(false);
    expect((await migrator.upTo(NAME)).executed).toEqual([NAME]);
    expect(await db.knex.schema.hasColumn('runs', 'accepts_input')).toBe(true);
    expect((await migrator.rollback()).rolledBack).toEqual([NAME]);
    expect(await db.knex.schema.hasColumn('runs', 'accepts_input')).toBe(false);
    await migrator.latest();
  },
);
