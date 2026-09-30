// @vitest-environment node
/**
 * NP-183: the project manager assistant migration. Up: the new tables, nullable issue numbers, the new columns with
 * their defaults, and the idempotent pmConversations backfill for existing conversations. Down: everything gone again,
 * refused while an issue has no number.
 */
import { createMigrator } from '@nocobase/db';
import { afterAll, expect, it } from 'vitest';

import { MIGRATIONS_DIR, openNpTestDatabase } from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_pm_assistant_migration', {
  migrate: false,
});
const skipped = 'skip' in opened;
if (skipped) console.warn(opened.skip);
const db = opened as Exclude<typeof opened, { skip: string }>;
afterAll(() => (skipped ? undefined : db.close()));

const NAME = '2026101200001_np_pm_assistant';
const TABLES = [
  'pm_conversations',
  'pm_plans',
  'pm_plan_ops',
  'pm_act_writes',
] as const;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.knex.raw(sql, params);
  return (result as { rows: T[] }).rows;
}

async function tables(): Promise<string[]> {
  return (
    await rows<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
      [db.schema],
    )
  ).map((row) => row.table_name);
}

async function columns(table: string): Promise<Map<string, string>> {
  return new Map(
    (
      await rows<{ column_name: string; is_nullable: string }>(
        'SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
        [db.schema, table],
      )
    ).map((row) => [row.column_name, row.is_nullable]),
  );
}

async function seedIssue(id: string, number: number, originType: string) {
  await db.knex.raw(
    `INSERT INTO "${db.schema}".issues (id, number, identifier, title, description, status_key, priority, owner_user_id,
       executor_type, executor_id, revision, origin_type, created_by_id, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, 't', '', 'todo', 'none', 'u1', 'agent', 'a1', 1, ?, 'u1', '2026-09-01T00:00:00Z', now(), now())`,
    [id, number, `NP-${number}`, originType],
  );
}

it.skipIf(skipped)(
  'adds the assistant tables, backfills conversations and rolls back alone',
  async () => {
    const migrator = createMigrator({
      database: db.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });
    await migrator.upTo('2026101000001_np_computers');
    await seedIssue('i1', 1, 'pm');
    await seedIssue('i2', 2, 'manual');
    await db.knex.raw(
      `INSERT INTO "${db.schema}".members (id, user_id, role, joined_at, created_at, updated_at)
       VALUES ('m1', 'u1', 'member', now(), now(), now())`,
    );

    const applied = await migrator.upTo(NAME);
    expect(applied.executed).toEqual([NAME]);
    expect(await tables()).toEqual(expect.arrayContaining([...TABLES]));
    const issues = await columns('issues');
    expect(issues.get('number')).toBe('YES');
    expect(issues.get('identifier')).toBe('YES');
    expect([...(await columns('comments')).keys()]).toEqual(
      expect.arrayContaining(['context', 'via']),
    );
    expect(
      await rows(`SELECT pm_allowed FROM "${db.schema}".runtimes`),
    ).toEqual([]);
    expect(
      await rows(
        `SELECT pm_confirm_all, pm_agent_mode, pm_agent_id, preferences_revision FROM "${db.schema}".members`,
      ),
    ).toEqual([
      {
        pm_confirm_all: false,
        pm_agent_mode: 'system',
        pm_agent_id: null,
        preferences_revision: 1,
      },
    ]);
    expect(
      await rows(
        `SELECT issue_id, owner_user_id, agent_id, agent_source, title_source FROM "${db.schema}".pm_conversations`,
      ),
    ).toEqual([
      {
        issue_id: 'i1',
        owner_user_id: 'u1',
        agent_id: 'a1',
        agent_source: 'system',
        title_source: 'auto',
      },
    ]);

    // Down refuses while an issue has no number.
    await db.knex.raw(
      `INSERT INTO "${db.schema}".issues (id, number, identifier, title, description, status_key, priority, owner_user_id,
         executor_type, revision, origin_type, created_by_id, created_at, updated_at, last_activity_at)
       VALUES ('i3', NULL, NULL, 'c', '', 'todo', 'none', 'u1', 'none', 1, 'pm', 'u1', now(), now(), now())`,
    );
    await expect(migrator.rollback()).rejects.toThrow(/fix forward/u);
    await db.knex.raw(`DELETE FROM "${db.schema}".issues WHERE id = 'i3'`);

    const rolledBack = await migrator.rollback();
    expect(rolledBack.rolledBack).toEqual([NAME]);
    const remaining = await tables();
    for (const table of TABLES) expect(remaining).not.toContain(table);
    expect((await columns('issues')).get('number')).toBe('NO');
    expect((await columns('members')).has('pm_agent_mode')).toBe(false);
  },
);
