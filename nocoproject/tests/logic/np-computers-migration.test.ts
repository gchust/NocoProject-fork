// @vitest-environment node
/** NP-150: the computer credentials table is created and rolled back on its own. */
import { createMigrator } from '@nocobase/db';
import { afterAll, expect, it } from 'vitest';

import { MIGRATIONS_DIR, openNpTestDatabase } from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_computers_migration', {
  migrate: false,
});
const skipped = 'skip' in opened;
if (skipped) console.warn(opened.skip);
const db = opened as Exclude<typeof opened, { skip: string }>;
afterAll(() => (skipped ? undefined : db.close()));

async function hasTable(name: string): Promise<boolean> {
  const result = await db.knex.raw(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [db.schema, name],
  );
  return (result as { rows: unknown[] }).rows.length > 0;
}

it.skipIf(skipped)('adds np_computers and rolls it back alone', async () => {
  const migrator = createMigrator({
    database: db.database,
    directory: MIGRATIONS_DIR,
    packageName: 'nocoproject',
  });
  await migrator.upTo('2026100900001_np_pr_merge_checks');
  expect(await hasTable('np_computers')).toBe(false);
  const applied = await migrator.upTo('2026101000001_np_computers');
  expect(applied.executed).toEqual(['2026101000001_np_computers']);
  expect(await hasTable('np_computers')).toBe(true);
  const rolledBack = await migrator.rollback();
  expect(rolledBack.rolledBack).toEqual(['2026101000001_np_computers']);
  expect(await hasTable('np_computers')).toBe(false);
});
