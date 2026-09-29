// @vitest-environment node
import { afterAll, expect, it } from 'vitest';
import { createMigrator } from '@nocobase/db';
import { MIGRATIONS_DIR, openNpTestDatabase } from './np-harness.ts';
const opened = await openNpTestDatabase('np_t_configuration_migration', {
  migrate: false,
});
const skipped = 'skip' in opened;
if (skipped) console.warn(opened.skip);
const db = opened as Exclude<typeof opened, { skip: string }>;
afterAll(() => (skipped ? undefined : db.close()));
it.skipIf(skipped)(
  'backfills explicit permissions without changing instructions and refuses destructive rollback',
  async () => {
    const migrator = createMigrator({
      database: db.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });
    await migrator.upTo('2026100700001_np_agent_deletion');
    await db.knex
      .withSchema(db.schema)
      .table('agents')
      .insert(
        ['manager', 'coder'].map((kind) => ({
          id: kind,
          name: 'same name',
          owner_user_id: 'u-alice',
          instructions: 'My exact instructions',
          provider: 'echo',
          kind,
          created_at: new Date(),
          updated_at: new Date(),
        })),
      );
    await db.knex
      .withSchema(db.schema)
      .table('system_settings')
      .insert({
        id: 'default',
        issue_prefix: 'NP',
        issue_counter: 0,
        settings: JSON.stringify({
          pmAgentId: 'manager',
          retrospectiveOnDone: true,
        }),
      });
    await migrator.latest();
    const agents = await db.knex
      .withSchema(db.schema)
      .table('agents')
      .select('*')
      .orderBy('id');
    expect(agents[0].capabilities).toContain('subtask.create');
    expect(agents[1].capabilities).not.toContain('subtask.create');
    expect(agents.map((a) => a.instructions)).toEqual([
      'My exact instructions',
      'My exact instructions',
    ]);
    const settings = await db.knex
      .withSchema(db.schema)
      .table('system_settings')
      .first();
    expect(
      (typeof settings.settings === 'string'
        ? JSON.parse(settings.settings)
        : settings.settings
      ).agentEntries.completion.agentId,
    ).toBe('manager');
    await db.knex
      .withSchema(db.schema)
      .table('agents')
      .where('id', 'manager')
      .update({ instructions: 'Edited later' });
    expect((await migrator.latest()).executed).toEqual([]);
    expect(
      (
        await db.knex
          .withSchema(db.schema)
          .table('agents')
          .where('id', 'manager')
          .first()
      ).instructions,
    ).toBe('Edited later');
    await expect(migrator.rollback()).rejects.toThrow();
  },
);
