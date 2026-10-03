// @vitest-environment node
/**
 * NP-219: the runtime types migration. Up: `runtimeType` on agents, runtimes and runs (existing rows become
 * `computer`), the built-in runtime columns and the runs index. Down: refused while a built-in runtime exists, then
 * everything gone again, rolled back alone.
 */
import { createMigrator } from '@nocobase/db';
import { afterAll, expect, it } from 'vitest';

import { MIGRATIONS_DIR, openNpTestDatabase } from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_runtime_types_migration', {
  migrate: false,
});
const skipped = 'skip' in opened;
if (skipped) console.warn(opened.skip);
const db = opened as Exclude<typeof opened, { skip: string }>;
afterAll(() => (skipped ? undefined : db.close()));

const NAME = '2026101400001_np_runtime_types';

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.knex.raw(sql, params);
  return (result as { rows: T[] }).rows;
}

async function columns(table: string): Promise<Set<string>> {
  return new Set(
    (
      await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
        [db.schema, table],
      )
    ).map((row) => row.column_name),
  );
}

async function indexes(): Promise<string[]> {
  return (
    await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = ? AND tablename = 'runs'`,
      [db.schema],
    )
  ).map((row) => row.indexname);
}

it.skipIf(skipped)(
  'adds the runtime types, defaults existing rows to computer and rolls back alone',
  async () => {
    const migrator = createMigrator({
      database: db.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });
    await migrator.upTo('2026101300001_np_comment_attachments');
    const s = `"${db.schema}"`;
    await db.knex.raw(
      `INSERT INTO ${s}.runtimes (id, daemon_id, provider, name, kind, owner_user_id, visibility, status, created_at, updated_at)
       VALUES ('rt1', 'd1', 'claude', 'Mac (claude)', 'personal', 'u1', 'private', 'online', now(), now())`,
    );
    await db.knex.raw(
      `INSERT INTO ${s}.agents (id, name, owner_user_id, instructions, runtime_id, provider, max_concurrent_runs, access, created_at, updated_at)
       VALUES ('a1', 'Coder', 'u1', '', 'rt1', 'claude', 1, 'ownerOnly', now(), now())`,
    );

    const applied = await migrator.upTo(NAME);
    expect(applied.executed).toEqual([NAME]);
    for (const table of ['agents', 'runtimes', 'runs'])
      expect((await columns(table)).has('runtime_type')).toBe(true);
    const runtime = await columns('runtimes');
    for (const column of ['llm_service', 'status_reason', 'last_checked_at'])
      expect(runtime.has(column)).toBe(true);
    expect(await indexes()).toContain('np_runs_runtime_type_status_idx');
    expect(await rows(`SELECT id, runtime_type FROM ${s}.agents`)).toEqual([
      { id: 'a1', runtime_type: 'computer' },
    ]);
    expect(
      await rows(
        `SELECT id, runtime_type, llm_service, status_reason FROM ${s}.runtimes`,
      ),
    ).toEqual([
      {
        id: 'rt1',
        runtime_type: 'computer',
        llm_service: null,
        status_reason: null,
      },
    ]);

    // A built-in runtime makes the rollback refuse (fix forward).
    await db.knex.raw(
      `INSERT INTO ${s}.runtimes (id, daemon_id, provider, runtime_type, llm_service, name, kind, owner_user_id, visibility, status, created_at, updated_at)
       VALUES ('rt2', 'builtin:deepseek', 'nocobase-ai', 'builtin', 'deepseek', 'DeepSeek', 'server', 'u1', 'public', 'online', now(), now())`,
    );
    await expect(migrator.rollback()).rejects.toThrow(/fix forward/u);
    await db.knex.raw(`DELETE FROM ${s}.runtimes WHERE id = 'rt2'`);

    const rolledBack = await migrator.rollback();
    expect(rolledBack.rolledBack).toEqual([NAME]);
    for (const table of ['agents', 'runtimes', 'runs'])
      expect((await columns(table)).has('runtime_type')).toBe(false);
    expect((await columns('runtimes')).has('llm_service')).toBe(false);
    expect(await indexes()).not.toContain('np_runs_runtime_type_status_idx');
    expect(await rows(`SELECT id FROM ${s}.agents`)).toEqual([{ id: 'a1' }]);
  },
);
