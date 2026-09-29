// @vitest-environment node
/**
 * The NocoProject migrations and seeds against a real PostgreSQL: up, indexes (including the partial pending-run
 * index), seed idempotency (iteration 4: the design-first statuses on both templates), down, and up again; each
 * iteration's batch rolls back alone (the Phase 2 batches: `np-migration-phase2.test.ts`; NP-78's attachments table at the end).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createMigrator, createSeeder } from '@nocobase/db';

import {
  MIGRATIONS_DIR,
  NP_ATTACHMENT_TABLES,
  NP_INVITATION_TABLES,
  NP_PHASE1_ITER2_TABLES,
  NP_PHASE1_ITER3_TABLES,
  NP_PHASE1_TABLES,
  NP_PHASE2_PROPOSAL_TABLES,
  NP_PHASE2_WORKFLOW_TABLES,
  NP_TABLES,
  SEEDS_DIR,
  openNpTestDatabase,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_migration', { migrate: false });
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-migration] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

async function tables(db: NpTestDatabase): Promise<string[]> {
  const result = await db.knex.raw(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
    [db.schema],
  );
  return (result as { rows: { table_name: string }[] }).rows.map(
    (row) => row.table_name,
  );
}

async function indexes(db: NpTestDatabase): Promise<Map<string, string>> {
  const result = await db.knex.raw(
    'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ?',
    [db.schema],
  );
  return new Map(
    (result as { rows: { indexname: string; indexdef: string }[] }).rows.map(
      (row) => [row.indexname, row.indexdef],
    ),
  );
}

const PHASE1_ALL_TABLES = [...NP_PHASE1_TABLES, 'workflow_templates'];

async function columns(db: NpTestDatabase, table: string): Promise<string[]> {
  const result = await db.knex.raw(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
    [db.schema, table],
  );
  return (result as { rows: { column_name: string }[] }).rows.map(
    (row) => row.column_name,
  );
}

describe.skipIf(!db)('NocoProject migrations (PostgreSQL)', () => {
  const migrator = () =>
    createMigrator({
      database: db!.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });
  const seeder = () =>
    createSeeder({
      database: db!.database,
      directory: SEEDS_DIR,
      packageName: 'nocoproject',
    });

  it('creates every table and the declared indexes', async () => {
    const result = await migrator().upTo('2026100700001_np_agent_deletion');
    expect(result.executed).toContain('2026092700001_np_phase0');
    expect(await tables(db!)).toEqual(expect.arrayContaining([...NP_TABLES]));

    const defs = await indexes(db!);
    expect(defs.get('np_runs_status_idx')).toContain('(status)');
    expect(defs.get('np_runs_agent_status_idx')).toContain(
      '(agent_id, status)',
    );
    expect(defs.get('np_runs_runtime_status_idx')).toContain(
      '(runtime_id, status)',
    );
    expect(defs.get('np_run_events_run_seq_unique')).toMatch(
      /UNIQUE.*\(run_id, seq\)/u,
    );
    expect(defs.get('np_run_sessions_unique')).toMatch(
      /UNIQUE.*\(agent_id, runtime_id, subject_type, subject_id\)/u,
    );
    expect(defs.get('np_runtimes_daemon_provider_unique')).toMatch(
      /UNIQUE.*\(daemon_id, provider\)/u,
    );
    expect(defs.get('np_run_tokens_hash_unique')).toMatch(/UNIQUE.*\(hash\)/u);
    expect(defs.get('np_issues_number_unique')).toMatch(/UNIQUE.*\(number\)/u);
    expect(defs.get('np_comments_issue_idx')).toContain('(issue_id)');
    expect(defs.get('np_activities_issue_idx')).toContain('(issue_id)');
    const pending = defs.get('np_runs_pending_unique') ?? '';
    expect(pending).toMatch(/UNIQUE.*COALESCE\(thread_scope/u);
    expect(pending).toContain('WHERE');
  });

  it('adds the iteration 1 tables, columns and partial indexes', async () => {
    expect(await tables(db!)).toEqual(
      expect.arrayContaining(PHASE1_ALL_TABLES),
    );
    const defs = await indexes(db!);
    expect(defs.get('np_inbox_items_dedupe_unique')).toMatch(
      /UNIQUE.*\(dedupe_key\) WHERE \(resolved_at IS NULL\)/u,
    );
    expect(defs.get('np_workflow_templates_default_unique')).toMatch(
      /UNIQUE.*WHERE is_default/u,
    );
    expect(defs.get('np_members_user_unique')).toMatch(/UNIQUE.*\(user_id\)/u);
    expect(defs.get('np_issue_dependencies_unique')).toMatch(
      /UNIQUE.*\(issue_id, depends_on_issue_id, type\)/u,
    );
    expect(defs.get('np_issues_parent_idx')).toContain('(parent_issue_id)');
    expect(await columns(db!, 'projects')).toEqual(
      expect.arrayContaining(['visibility', 'lead_user_id', 'workflow_id']),
    );
    expect(await columns(db!, 'issues')).toEqual(
      expect.arrayContaining([
        'stage',
        'start_date',
        'due_date',
        'auto_execute_subtasks',
        'suggested_executor_agent_id',
      ]),
    );
    expect(await columns(db!, 'runs')).toEqual(
      expect.arrayContaining(['branch_name', 'repo_url']),
    );
    expect(await columns(db!, 'run_sessions')).toEqual(
      expect.arrayContaining(['branch_name', 'repo_url']),
    );
    const insert = (id: string, resolved: boolean) =>
      db!.knex.raw(
        `INSERT INTO "${db!.schema}".inbox_items (id, user_id, kind, type, title, dedupe_key, resolved_at, created_at, updated_at)
         VALUES (?, 'u1', 'info', 'commented', 't', 'k1', ${resolved ? 'now()' : 'NULL'}, now(), now())`,
        [id],
      );
    await insert('i1', false);
    await expect(insert('i2', false)).rejects.toThrow(
      /np_inbox_items_dedupe_unique/u,
    );
    await insert('i3', true);
    await db!.knex.raw(`DELETE FROM "${db!.schema}".inbox_items`);
  });

  it('adds the iteration 2 tables, columns and the pending-approval index', async () => {
    expect(await tables(db!)).toEqual(
      expect.arrayContaining([...NP_PHASE1_ITER2_TABLES]),
    );
    const defs = await indexes(db!);
    expect(defs.get('np_pull_requests_repo_number_unique')).toMatch(
      /UNIQUE.*\(repo, number\)/u,
    );
    expect(defs.get('np_webhook_deliveries_unique')).toMatch(
      /UNIQUE.*\(provider, delivery_id\)/u,
    );
    expect(defs.get('np_git_connections_provider_unique')).toMatch(
      /UNIQUE.*\(provider\)/u,
    );
    expect(defs.get('np_comment_reactions_unique')).toMatch(
      /UNIQUE.*\(comment_id, user_id, emoji\)/u,
    );
    expect(await columns(db!, 'issues')).toEqual(
      expect.arrayContaining([
        'execution_mode',
        'origin_type',
        'origin_id',
        'deleted_at',
      ]),
    );
    expect(await columns(db!, 'comments')).toEqual(
      expect.arrayContaining(['resolved_at', 'resolved_by_id']),
    );
    const insert = (id: string, status: string) =>
      db!.knex.raw(
        `INSERT INTO "${db!.schema}".approval_requests (id, issue_id, from_status, to_status, requested_by_type,
           requested_by_id, approver_user_ids, status, created_at, updated_at)
         VALUES (?, 'i1', 'in_review', 'done', 'user', 'u1', '[]', ?, now(), now())`,
        [id, status],
      );
    await insert('a1', 'pending');
    await expect(insert('a2', 'pending')).rejects.toThrow(
      /np_approval_requests_pending_unique/u,
    );
    await insert('a3', 'rejected');
    await db!.knex.raw(`DELETE FROM "${db!.schema}".approval_requests`);
  });

  it('adds the iteration 3 knowledge tables and list indexes', async () => {
    expect(await tables(db!)).toEqual(
      expect.arrayContaining([...NP_PHASE1_ITER3_TABLES]),
    );
    const defs = await indexes(db!);
    expect(defs.get('np_knowledge_docs_project_slug_unique')).toMatch(
      /UNIQUE.*\(project_id, slug\)/u,
    );
    expect(defs.get('np_knowledge_doc_versions_unique')).toMatch(
      /UNIQUE.*\(doc_id, version\)/u,
    );
    expect(defs.get('np_knowledge_proposals_status_project_idx')).toContain(
      '(status, project_id)',
    );
    expect(defs.get('np_issues_project_status_updated_idx')).toContain(
      '(project_id, status_key, updated_at)',
    );
    expect(defs.get('np_issues_owner_status_idx')).toContain(
      '(owner_user_id, status_key)',
    );
    expect(defs.get('np_issues_executor_status_idx')).toContain(
      '(executor_type, executor_id, status_key)',
    );
    expect(defs.get('np_activities_issue_created_idx')).toContain(
      '(issue_id, created_at',
    );
    expect(defs.get('np_inbox_items_user_kind_resolved_idx')).toContain(
      '(user_id, kind, resolved_at, created_at',
    );
    // System-level documents store project_id '' so the unique index covers them.
    const insert = (id: string, projectId: string) =>
      db!.knex.raw(
        `INSERT INTO "${db!.schema}".knowledge_docs (id, project_id, title, slug, content, version, updated_by_type,
           created_at, updated_at) VALUES (?, ?, 't', 'same', '', 1, 'user', now(), now())`,
        [id, projectId],
      );
    await insert('k1', '');
    await expect(insert('k2', '')).rejects.toThrow(
      /np_knowledge_docs_project_slug_unique/u,
    );
    await insert('k3', 'p1');
    await db!.knex.raw(`DELETE FROM "${db!.schema}".knowledge_docs`);
  });

  it('adds the iteration 4 issue and agent columns with their defaults', async () => {
    const defaults = (await db!.knex.raw(
      `SELECT table_name, column_name, column_default, is_nullable FROM information_schema.columns
       WHERE table_schema = ? AND table_name IN ('issues', 'agents')
         AND column_name IN ('process', 'design_approved_at', 'design_approved_by_id', 'kind', 'reasoning_effort')
       ORDER BY table_name, column_name`,
      [db!.schema],
    )) as {
      rows: {
        table_name: string;
        column_name: string;
        column_default: string | null;
        is_nullable: string;
      }[];
    };
    expect(
      defaults.rows.map((row) => [
        row.table_name,
        row.column_name,
        row.column_default?.replace(/::character varying$/u, '') ?? null,
        row.is_nullable,
      ]),
    ).toEqual([
      ['agents', 'kind', "'coder'", 'NO'],
      ['agents', 'reasoning_effort', null, 'YES'],
      ['issues', 'design_approved_at', null, 'YES'],
      ['issues', 'design_approved_by_id', null, 'YES'],
      ['issues', 'process', "'direct'", 'NO'],
    ]);
  });

  it('enforces one pending run per agent, subject and thread scope', async () => {
    const insert = (id: string, status: string, scope: string | null) =>
      db!.knex.raw(
        `INSERT INTO "${db!.schema}".runs (id, agent_id, status, subject_type, subject_id, thread_scope, created_at, updated_at)
         VALUES (?, 'a1', ?, 'issue', 'i1', ?, now(), now())`,
        [id, status, scope],
      );
    await insert('r1', 'queued', null);
    await expect(insert('r2', 'dispatched', null)).rejects.toThrow(
      /np_runs_pending_unique/u,
    );
    await insert('r3', 'queued', 'thread-1');
    await insert('r4', 'running', null);
    await insert('r5', 'completed', null);
    await db!.knex.raw(`DELETE FROM "${db!.schema}".runs`);
  });

  it('seeds the settings row and the default workflow once', async () => {
    const first = await seeder().run();
    expect(first.executed).toEqual(
      expect.arrayContaining([
        '2026092700002_np_system_settings',
        '2026092800002_np_default_workflow',
        // No authorization tables in this schema: the grant seeds run and do nothing.
        '2026092800003_np_member_page_grants',
        '2026092900002_np_workflow_with_approval',
        '2026092900003_np_iter2_page_grants',
        '2026092900004_np_github_settings_grant',
        '2026093000002_np_iter3_page_grants',
        '2026100100002_np_iter4_workflow_statuses',
        '2026100100003_np_iter4_page_grants',
        '2026100400003_np_api_keys_page_grant',
      ]),
    );
    const workflows = (await db!.knex.raw(
      `SELECT id, name, is_default FROM "${db!.schema}".workflow_templates`,
    )) as { rows: { id: string; name: string; is_default: boolean }[] };
    expect(workflows.rows).toEqual(
      expect.arrayContaining([
        { id: 'default', name: '软件开发', is_default: true },
        {
          id: 'software-with-approval',
          name: '软件开发（验收审批）',
          is_default: false,
        },
      ]),
    );
    expect(workflows.rows).toHaveLength(2);
    // Iteration 4: both templates gained analysis and proposal_review after todo, and their transitions.
    const definitions = (await db!.knex.raw(
      `SELECT id, definition FROM "${db!.schema}".workflow_templates ORDER BY id`,
    )) as { rows: { id: string; definition: unknown }[] };
    for (const row of definitions.rows) {
      const definition = (
        typeof row.definition === 'string'
          ? JSON.parse(row.definition)
          : row.definition
      ) as {
        statuses: { key: string; category: string }[];
        transitions: { from: string; to: string; actors: string[] }[];
      };
      expect(definition.statuses.map((status) => status.key)).toEqual([
        'backlog',
        'todo',
        'analysis',
        'proposal_review',
        'in_progress',
        'in_review',
        'blocked',
        'done',
        'cancelled',
      ]);
      expect(
        definition.statuses.find((status) => status.key === 'analysis')
          ?.category,
      ).toBe('started');
      expect(definition.transitions).toEqual(
        expect.arrayContaining([
          { from: 'todo', to: 'analysis', actors: ['agent', 'user'] },
          {
            from: 'proposal_review',
            to: 'in_progress',
            actors: ['system', 'user'],
          },
          { from: 'blocked', to: 'analysis', actors: ['agent'] },
        ]),
      );
    }
    await db!.knex.raw(
      `UPDATE "${db!.schema}".system_settings SET issue_counter = 7`,
    );
    const again = await seeder().run();
    expect(again.executed).toEqual([]);
    const rows = (await db!.knex.raw(
      `SELECT * FROM "${db!.schema}".system_settings`,
    )) as {
      rows: { id: string; issue_prefix: string; issue_counter: number }[];
    };
    expect(rows.rows).toEqual([
      expect.objectContaining({
        id: 'default',
        issue_prefix: 'NP',
        issue_counter: 7,
      }),
    ]);
  });

  it('rolls back completely and applies again', async () => {
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual([
      '2026100700001_np_agent_deletion',
      '2026100600001_np_member_preferences',
      '2026100500001_np_invitations',
      '2026100400002_np_file_intake_batch',
      '2026100400001_np_phase2_workflow_proposals',
      '2026100400001_np_attachments',
      '2026100200001_np_pr_merge',
      '2026100200001_np_phase2_stage_actions',
      '2026100100001_np_phase1_iter4',
      '2026093000001_np_phase1_iter3',
      '2026092900001_np_phase1_iter2',
      '2026092800001_np_phase1_iter1',
      '2026092700001_np_phase0',
    ]);
    const remaining = await tables(db!);
    for (const table of [
      ...NP_TABLES,
      ...PHASE1_ALL_TABLES,
      ...NP_PHASE1_ITER2_TABLES,
      ...NP_PHASE1_ITER3_TABLES,
      ...NP_PHASE2_WORKFLOW_TABLES,
      ...NP_PHASE2_PROPOSAL_TABLES,
      ...NP_ATTACHMENT_TABLES,
      ...NP_INVITATION_TABLES,
    ])
      expect(remaining).not.toContain(table);
    const defs = await indexes(db!);
    expect(defs.has('np_runs_pending_unique')).toBe(false);
    expect(defs.has('np_inbox_items_dedupe_unique')).toBe(false);
    expect(defs.has('np_approval_requests_pending_unique')).toBe(false);

    const again = await migrator().upTo('2026100700001_np_agent_deletion');
    expect(again.executed).toContain('2026092700001_np_phase0');
    expect((await indexes(db!)).has('np_runs_pending_unique')).toBe(true);
  });

  it('rolls back the iteration 3 batch alone', async () => {
    await migrator().rollback();
    await migrator().upTo('2026092900001_np_phase1_iter2');
    const applied = await migrator().upTo('2026093000001_np_phase1_iter3');
    expect(applied.executed).toEqual(['2026093000001_np_phase1_iter3']);
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual(['2026093000001_np_phase1_iter3']);
    const remaining = await tables(db!);
    for (const table of NP_PHASE1_ITER3_TABLES)
      expect(remaining).not.toContain(table);
    expect(remaining).toEqual(
      expect.arrayContaining([...NP_PHASE1_ITER2_TABLES]),
    );
    const defs = await indexes(db!);
    for (const name of [
      'np_issues_project_status_updated_idx',
      'np_issues_owner_status_idx',
      'np_issues_executor_status_idx',
      'np_issues_updated_idx',
      'np_activities_issue_created_idx',
      'np_inbox_items_user_kind_resolved_idx',
    ])
      expect(defs.has(name)).toBe(false);
    expect(defs.has('np_approval_requests_pending_unique')).toBe(true);
    await migrator().upTo('2026100700001_np_agent_deletion');
  });

  it('rolls back the iteration 4 batch alone', async () => {
    await migrator().rollback();
    await migrator().upTo('2026093000001_np_phase1_iter3');
    const applied = await migrator().upTo('2026100100001_np_phase1_iter4');
    expect(applied.executed).toEqual(['2026100100001_np_phase1_iter4']);
    expect(await columns(db!, 'issues')).toContain('process');
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual(['2026100100001_np_phase1_iter4']);
    const issueColumns = await columns(db!, 'issues');
    for (const column of [
      'process',
      'design_approved_at',
      'design_approved_by_id',
    ])
      expect(issueColumns).not.toContain(column);
    const agentColumns = await columns(db!, 'agents');
    expect(agentColumns).not.toContain('kind');
    expect(agentColumns).not.toContain('reasoning_effort');
    expect(await tables(db!)).toEqual(
      expect.arrayContaining([...NP_PHASE1_ITER3_TABLES]),
    );
    await migrator().upTo('2026100700001_np_agent_deletion');
  });

  it('adds and drops the pull request CI link columns (NP-85)', async () => {
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026100200001_np_phase2_stage_actions');
    expect(await columns(db!, 'pull_requests')).not.toContain('ci_run_url');
    const applied = await migrator().upTo('2026100200001_np_pr_merge');
    expect(applied.executed).toEqual(['2026100200001_np_pr_merge']);
    const added = await columns(db!, 'pull_requests');
    expect(added).toEqual(
      expect.arrayContaining(['ci_run_url', 'screenshots_url']),
    );
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual(['2026100200001_np_pr_merge']);
    const remaining = await columns(db!, 'pull_requests');
    expect(remaining).not.toContain('ci_run_url');
    expect(remaining).not.toContain('screenshots_url');
    expect(remaining).toContain('mergeable_state');
    await migrator().upTo('2026100700001_np_agent_deletion');
  });

  it('rolls back an iteration 2 + 3 + 4 batch and keeps iteration 1', async () => {
    // Start from an empty schema whatever batches the previous cases left.
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026092800001_np_phase1_iter1');
    const applied = await migrator().upTo('2026100100001_np_phase1_iter4');
    expect(applied.executed).toEqual([
      '2026092900001_np_phase1_iter2',
      '2026093000001_np_phase1_iter3',
      '2026100100001_np_phase1_iter4',
    ]);
    // Applied together, they are one batch: rollback reverts iteration 4 first, then 3, then 2.
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual([
      '2026100100001_np_phase1_iter4',
      '2026093000001_np_phase1_iter3',
      '2026092900001_np_phase1_iter2',
    ]);
    const remaining = await tables(db!);
    for (const table of NP_PHASE1_ITER2_TABLES)
      expect(remaining).not.toContain(table);
    expect(remaining).toEqual(expect.arrayContaining(PHASE1_ALL_TABLES));
    const issueColumns = await columns(db!, 'issues');
    expect(issueColumns).not.toContain('execution_mode');
    expect(issueColumns).not.toContain('deleted_at');
    expect(issueColumns).toContain('stage');
    expect(await columns(db!, 'comments')).not.toContain('resolved_at');
    await migrator().upTo('2026100700001_np_agent_deletion');
  });

  it('adds the attachments table and rolls it back alone', async () => {
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026100200001_np_pr_merge');
    const applied = await migrator().upTo('2026100400001_np_attachments');
    expect(applied.executed).toEqual(['2026100400001_np_attachments']);
    expect(await tables(db!)).toEqual(
      expect.arrayContaining([...NP_ATTACHMENT_TABLES]),
    );
    expect(await columns(db!, 'np_files')).toEqual(
      expect.arrayContaining([
        'id',
        'disk',
        'key',
        'filename',
        'ext',
        'mime_type',
        'size',
        'uploaded_by_id',
        'issue_id',
        'created_at',
        'updated_at',
      ]),
    );
    expect((await indexes(db!)).get('np_files_issue_idx')).toContain(
      '(issue_id)',
    );
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual(['2026100400001_np_attachments']);
    expect(await tables(db!)).not.toContain('np_files');
    expect(await tables(db!)).toEqual(
      expect.arrayContaining([...NP_PHASE1_ITER3_TABLES]),
    );
    await migrator().upTo('2026100700001_np_agent_deletion');
  });

  it('adds the intake batch columns to the attachments table and rolls them back alone', async () => {
    while ((await migrator().rollback()).rolledBack.length > 0);
    await migrator().upTo('2026100400001_np_phase2_workflow_proposals');
    const applied = await migrator().upTo('2026100400002_np_file_intake_batch');
    expect(applied.executed).toEqual(['2026100400002_np_file_intake_batch']);
    expect(await columns(db!, 'np_files')).toEqual(
      expect.arrayContaining(['intake_batch_id', 'intake_read_status']),
    );
    expect((await indexes(db!)).get('np_files_intake_batch_idx')).toContain(
      '(intake_batch_id)',
    );
    const rolledBack = await migrator().rollback();
    expect(rolledBack.rolledBack).toEqual([
      '2026100400002_np_file_intake_batch',
    ]);
    const after = await columns(db!, 'np_files');
    expect(after).not.toContain('intake_batch_id');
    expect(after).not.toContain('intake_read_status');
    expect((await indexes(db!)).has('np_files_intake_batch_idx')).toBe(false);
    await migrator().upTo('2026100700001_np_agent_deletion');
  });
});
