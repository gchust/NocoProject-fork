// @vitest-environment node
/**
 * NP-214: the comment attachments migration. Up: `npFiles.commentId` (indexed) and `npFiles.uploadedByRunId`, both
 * nullable, existing rows untouched. Down: both columns and the index gone again, rolled back alone.
 */
import { createMigrator } from '@nocobase/db';
import { afterAll, expect, it } from 'vitest';

import { MIGRATIONS_DIR, openNpTestDatabase } from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_comment_attachments_migration', {
  migrate: false,
});
const skipped = 'skip' in opened;
if (skipped) console.warn(opened.skip);
const db = opened as Exclude<typeof opened, { skip: string }>;
afterAll(() => (skipped ? undefined : db.close()));

const NAME = '2026101300001_np_comment_attachments';

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.knex.raw(sql, params);
  return (result as { rows: T[] }).rows;
}

async function columns(): Promise<Map<string, string>> {
  return new Map(
    (
      await rows<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = ? AND table_name = 'np_files'`,
        [db.schema],
      )
    ).map((row) => [row.column_name, row.is_nullable]),
  );
}

async function indexes(): Promise<string[]> {
  return (
    await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = ? AND tablename = 'np_files'`,
      [db.schema],
    )
  ).map((row) => row.indexname);
}

it.skipIf(skipped)(
  'adds the comment columns to npFiles and rolls back alone',
  async () => {
    const migrator = createMigrator({
      database: db.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });
    await migrator.upTo('2026101200001_np_pm_assistant');
    await db.knex.raw(
      `INSERT INTO "${db.schema}".np_files
         (id, disk, key, filename, ext, mime_type, size, uploaded_by_id, issue_id, created_at, updated_at)
       VALUES ('00000000-0000-4000-8000-000000000001', 'local', 'objects/a.txt', 'a.txt', 'txt', 'text/plain', 1,
         'u1', 'i1', now(), now())`,
    );

    const applied = await migrator.upTo(NAME);
    expect(applied.executed).toEqual([NAME]);
    const added = await columns();
    expect(added.get('comment_id')).toBe('YES');
    expect(added.get('uploaded_by_run_id')).toBe('YES');
    expect(await indexes()).toContain('np_files_comment_idx');
    expect(
      await rows(
        `SELECT issue_id, comment_id, uploaded_by_run_id FROM "${db.schema}".np_files`,
      ),
    ).toEqual([{ issue_id: 'i1', comment_id: null, uploaded_by_run_id: null }]);

    const rolledBack = await migrator.rollback();
    expect(rolledBack.rolledBack).toEqual([NAME]);
    const left = await columns();
    expect(left.has('comment_id')).toBe(false);
    expect(left.has('uploaded_by_run_id')).toBe(false);
    expect(await indexes()).not.toContain('np_files_comment_idx');
    expect(await rows(`SELECT issue_id FROM "${db.schema}".np_files`)).toEqual([
      { issue_id: 'i1' },
    ]);
  },
);
