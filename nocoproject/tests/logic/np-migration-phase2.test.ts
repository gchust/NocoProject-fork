// @vitest-environment node
/**
 * The Phase 2 migrations against a real PostgreSQL. NP-77 stage actions: up (the checklist table and its unique index,
 * the new proposal columns, a nullable proposing agent) and down (workflow suggestions removed, NOT NULL again).
 * NP-77 stage 2 workflow proposals: up (template `revision` / `isSystem` with their defaults, the revision and proposal
 * tables and indexes) and down (tables and columns gone). NP-88: the invitations table with its unique token index.
 * NP-108: the members' `inbox_chime` column, on for existing rows, and gone again on rollback.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createMigrator } from '@nocobase/db';

import {
  MIGRATIONS_DIR,
  NP_INVITATION_TABLES,
  NP_PHASE2_PROPOSAL_TABLES,
  NP_PHASE2_WORKFLOW_TABLES,
  openNpTestDatabase,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_migration_phase2', {
  migrate: false,
});
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-migration-phase2] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

async function values(
  sql: string,
  params: readonly unknown[],
  column: string,
): Promise<string[]> {
  const result = await db!.knex.raw(sql, params as unknown[]);
  return (result as { rows: Record<string, string>[] }).rows.map(
    (row) => row[column],
  );
}

const tables = () =>
  values(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
    [db!.schema],
    'table_name',
  );
const columns = (_db: unknown, table: string) =>
  values(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
    [db!.schema, table],
    'column_name',
  );

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

describe.skipIf(!db)('NocoProject Phase 2 migrations (PostgreSQL)', () => {
  const migrator = () =>
    createMigrator({
      database: db!.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });

  it('rolls back the Phase 2 stage actions batch alone', async () => {
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026100100001_np_phase1_iter4');
    const applied = await migrator().upTo(
      '2026100200001_np_phase2_stage_actions',
    );
    expect(applied.executed).toEqual(['2026100200001_np_phase2_stage_actions']);
    expect(await tables()).toEqual(
      expect.arrayContaining([...NP_PHASE2_WORKFLOW_TABLES]),
    );
    expect((await indexes()).get('np_issue_checklist_items_unique')).toMatch(
      /UNIQUE.*\(issue_id, status_key, item_key\)/u,
    );
    expect(await columns(db!, 'executor_proposals')).toEqual(
      expect.arrayContaining(['source', 'stage_status_key']),
    );
    const insert = (id: string, source: string, by: string | null) =>
      db!.knex.raw(
        `INSERT INTO "${db!.schema}".executor_proposals (id, issue_id, proposed_agent_id, proposed_by_agent_id,
           status, source, created_at, updated_at)
         VALUES (?, 'i1', 'a1', ?, 'pending', ?, now(), now())`,
        [id, by, source],
      );
    await insert('p1', 'workflow', null);
    await insert('p2', 'agent', 'a2');
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual([
      '2026100200001_np_phase2_stage_actions',
    ]);
    expect(await tables()).not.toContain('issue_checklist_items');
    const proposalColumns = await columns(db!, 'executor_proposals');
    expect(proposalColumns).not.toContain('source');
    expect(proposalColumns).not.toContain('stage_status_key');
    const kept = await db!.knex.raw(
      `SELECT id FROM "${db!.schema}".executor_proposals ORDER BY id`,
    );
    expect((kept as { rows: { id: string }[] }).rows).toEqual([{ id: 'p2' }]);
    await expect(
      db!.knex.raw(
        `INSERT INTO "${db!.schema}".executor_proposals (id, issue_id, proposed_agent_id, proposed_by_agent_id,
           status, created_at, updated_at) VALUES ('p3', 'i1', 'a1', NULL, 'pending', now(), now())`,
      ),
    ).rejects.toThrow(/null value/u);
    await db!.knex.raw(`DELETE FROM "${db!.schema}".executor_proposals`);
    await migrator().latest();
  });

  it('creates the invitations table and rolls it back alone', async () => {
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026100400002_np_file_intake_batch');
    const applied = await migrator().upTo('2026100500001_np_invitations');
    expect(applied.executed).toEqual(['2026100500001_np_invitations']);
    expect(await tables()).toEqual(
      expect.arrayContaining([...NP_INVITATION_TABLES]),
    );
    expect(await columns(db!, 'np_invitations')).toEqual(
      expect.arrayContaining([
        'email',
        'token_hash',
        'project_ids',
        'status',
        'invited_by_id',
        'expires_at',
        'sent_at',
        'send_error',
        'accepted_user_id',
        'accepted_at',
      ]),
    );
    const defs = await indexes();
    expect(defs.get('np_invitations_token_unique')).toMatch(
      /UNIQUE.*\(token_hash\)/u,
    );
    expect(defs.get('np_invitations_email_idx')).toContain('(email, status)');
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual(['2026100500001_np_invitations']);
    expect(await tables()).not.toContain('np_invitations');
    await migrator().latest();
  });

  it('adds the inbox chime preference to members and rolls it back alone', async () => {
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026100500001_np_invitations');
    await db!.knex.raw(
      `INSERT INTO "${db!.schema}".members (id, user_id, role, joined_at, created_at, updated_at)
       VALUES ('m1', 'u1', 'member', now(), now(), now())`,
    );
    const applied = await migrator().upTo(
      '2026100600001_np_member_preferences',
    );
    expect(applied.executed).toEqual(['2026100600001_np_member_preferences']);
    const rows = await db!.knex.raw(
      `SELECT inbox_chime FROM "${db!.schema}".members WHERE id = 'm1'`,
    );
    expect((rows as { rows: unknown[] }).rows).toEqual([{ inbox_chime: true }]);
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual([
      '2026100600001_np_member_preferences',
    ]);
    expect(await columns(db!, 'members')).not.toContain('inbox_chime');
    await db!.knex.raw(`DELETE FROM "${db!.schema}".members`);
    await migrator().latest();
  });

  it('rolls back the Phase 2 workflow proposals batch alone', async () => {
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026100400001_np_attachments');
    await db!.knex.raw(
      `INSERT INTO "${db!.schema}".workflow_templates (id, name, is_default, definition, created_at, updated_at)
       VALUES ('t1', 'T', false, '{}', now(), now())`,
    );
    const applied = await migrator().upTo(
      '2026100400001_np_phase2_workflow_proposals',
    );
    expect(applied.executed).toEqual([
      '2026100400001_np_phase2_workflow_proposals',
    ]);
    expect(await tables()).toEqual(
      expect.arrayContaining([...NP_PHASE2_PROPOSAL_TABLES]),
    );
    const defaults = await db!.knex.raw(
      `SELECT revision, is_system FROM "${db!.schema}".workflow_templates WHERE id = 't1'`,
    );
    expect((defaults as { rows: unknown[] }).rows).toEqual([
      { revision: 1, is_system: false },
    ]);
    const defs = await indexes();
    expect(defs.get('np_workflow_template_revisions_unique')).toMatch(
      /UNIQUE.*\(template_id, revision\)/u,
    );
    expect(defs.get('np_workflow_proposals_status_template_idx')).toContain(
      '(status, template_id)',
    );
    expect(await columns(db!, 'workflow_proposals')).toEqual(
      expect.arrayContaining([
        'template_id',
        'copy_from_id',
        'base_definition',
        'base_revision',
        'result_revision',
      ]),
    );
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual([
      '2026100400001_np_phase2_workflow_proposals',
    ]);
    for (const table of NP_PHASE2_PROPOSAL_TABLES)
      expect(await tables()).not.toContain(table);
    const templateColumns = await columns(db!, 'workflow_templates');
    expect(templateColumns).not.toContain('revision');
    expect(templateColumns).not.toContain('is_system');
    await db!.knex.raw(
      `DELETE FROM "${db!.schema}".workflow_templates WHERE id = 't1'`,
    );
    await migrator().latest();
  });
});
