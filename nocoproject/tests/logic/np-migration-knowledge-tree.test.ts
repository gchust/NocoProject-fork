// @vitest-environment node
/**
 * NP-147: the knowledge tree migration against a real PostgreSQL. Up (knowledge_docs.parentId / sortOrder with their
 * defaults, the composite index, knowledge_proposals.parentId) and down (columns and index gone, rolled back alone).
 * Kept in its own file per the kb note on np-migration.test.ts growing past 500 lines.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createMigrator } from '@nocobase/db';

import {
  MIGRATIONS_DIR,
  openNpTestDatabase,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_migration_knowledge_tree', {
  migrate: false,
});
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-migration-knowledge-tree] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

async function columns(table: string): Promise<string[]> {
  const result = await db!.knex.raw(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
    [db!.schema, table],
  );
  return (result as { rows: { column_name: string }[] }).rows.map(
    (row) => row.column_name,
  );
}

async function indexes(): Promise<Map<string, string>> {
  const result = await db!.knex.raw(
    'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ?',
    [db!.schema],
  );
  return new Map(
    (result as { rows: { indexname: string; indexdef: string }[] }).rows.map(
      (row) => [row.indexname, row.indexdef],
    ),
  );
}

describe.skipIf(!db)('NP-147 knowledge tree migration (PostgreSQL)', () => {
  const migrator = () =>
    createMigrator({
      database: db!.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });

  it('adds parentId/sortOrder and rolls them back alone', async () => {
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026100700002_np_agent_configuration');
    expect(await columns('knowledge_docs')).not.toContain('parent_id');
    const applied = await migrator().upTo('2026100800001_np_knowledge_tree');
    expect(applied.executed).toEqual(['2026100800001_np_knowledge_tree']);

    const docColumns = await columns('knowledge_docs');
    expect(docColumns).toEqual(
      expect.arrayContaining(['parent_id', 'sort_order']),
    );
    expect(await columns('knowledge_proposals')).toContain('parent_id');
    expect((await indexes()).get('np_knowledge_docs_parent_idx')).toContain(
      '(project_id, parent_id, sort_order)',
    );

    // Existing default: a document with no parent, sortOrder 0.
    await db!.knex.raw(
      `INSERT INTO "${db!.schema}".knowledge_docs (id, project_id, title, slug, content, version, updated_by_type,
         created_at, updated_at) VALUES ('kd1', '', 't', 's1', '', 1, 'user', now(), now())`,
    );
    const defaults = await db!.knex.raw(
      `SELECT parent_id, sort_order FROM "${db!.schema}".knowledge_docs WHERE id = 'kd1'`,
    );
    expect((defaults as { rows: unknown[] }).rows).toEqual([
      { parent_id: null, sort_order: 0 },
    ]);
    await db!.knex.raw(
      `INSERT INTO "${db!.schema}".knowledge_docs (id, project_id, parent_id, sort_order, title, slug, content,
         version, updated_by_type, created_at, updated_at)
         VALUES ('kd2', '', 'kd1', 3, 'child', 's2', '', 1, 'user', now(), now())`,
    );
    const child = await db!.knex.raw(
      `SELECT parent_id, sort_order FROM "${db!.schema}".knowledge_docs WHERE id = 'kd2'`,
    );
    expect((child as { rows: unknown[] }).rows).toEqual([
      { parent_id: 'kd1', sort_order: 3 },
    ]);
    await db!.knex.raw(`DELETE FROM "${db!.schema}".knowledge_docs`);

    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual(['2026100800001_np_knowledge_tree']);
    const afterDown = await columns('knowledge_docs');
    expect(afterDown).not.toContain('parent_id');
    expect(afterDown).not.toContain('sort_order');
    expect(await columns('knowledge_proposals')).not.toContain('parent_id');
    expect((await indexes()).has('np_knowledge_docs_parent_idx')).toBe(false);
    await migrator().upTo('2026100800001_np_knowledge_tree');
  });
});
