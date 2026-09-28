// NocoProject Phase 0 schema (docs/phase0/protocol.md §1).
//
// The `activities` table is @temporary(nocobase-official): 待替换为 NocoBase 官方 活动流与变更事件.
//
// Self-contained on purpose: every field, index and constraint is spelled out here and nothing is imported from
// server/modules, so the meaning of this migration never changes after it has run.
import {
  defineMigration,
  type MigrationContext,
  type MigrationDefinition,
} from '@nocobase/db';
import type { Knex } from 'knex';

const ID = { length: 32 } as const;
const USER_ID = { length: 64 } as const;

// PostgreSQL-only: at most one pending (queued/deferred/dispatched) run per agent + subject + thread scope. The
// Collection Builder cannot declare a partial or expression index, so it is raw DDL on the physical table.
const PENDING_RUN_INDEX = 'np_runs_pending_unique';

async function postgresClient(
  connection: MigrationContext['connection'],
): Promise<Knex | undefined> {
  if (connection.dialect !== 'postgres') return undefined;
  return connection.client<Knex>();
}

type Builder = MigrationContext['builder'];

async function createIssueCollections(builder: Builder): Promise<void> {
  await builder.createCollection('systemSettings', (table) => {
    table.string('id', ID).primary();
    table.string('issuePrefix', { length: 16 }).notNull();
    table.integer('issueCounter').notNull().defaultTo(0);
    table.datetimeTz('updatedAt').nullable();
  });

  await builder.createCollection('projects', (table) => {
    table.string('id', ID).primary();
    table.string('name', { length: 255 }).notNull();
    table.text('description').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
  });

  await builder.createCollection('issues', (table) => {
    table.string('id', ID).primary();
    table.integer('number').notNull();
    table.string('identifier', { length: 32 }).notNull();
    table.string('title', { length: 500 }).notNull();
    table.text('description').nullable();
    table.string('statusKey', { length: 32 }).notNull();
    table.string('priority', { length: 16 }).notNull().defaultTo('none');
    table.string('ownerUserId', USER_ID).nullable();
    table.string('executorType', { length: 16 }).notNull().defaultTo('none');
    table.string('executorId', USER_ID).nullable();
    table.string('parentIssueId', ID).nullable();
    table.string('projectId', ID).nullable();
    table.integer('revision').notNull().defaultTo(1);
    table.datetimeTz('lastActivityAt').notNull();
    table.string('createdById', USER_ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique('number', { name: 'np_issues_number_unique' });
    table.index('statusKey', { name: 'np_issues_status_idx' });
  });

  await builder.createCollection('comments', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('authorType', { length: 16 }).notNull();
    table.string('authorId', USER_ID).nullable();
    table.text('content').notNull();
    table.string('kind', { length: 16 }).notNull().defaultTo('comment');
    table.string('parentId', ID).nullable();
    // Thread root, resolved once at insert (the comment itself for a top-level comment).
    table.string('rootId', ID).notNull();
    table.string('sourceRunId', ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index('issueId', { name: 'np_comments_issue_idx' });
  });

  // @temporary(nocobase-official): 待替换为 NocoBase 官方 活动流与变更事件
  await builder.createCollection('activities', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('actorType', { length: 16 }).notNull();
    table.string('actorId', USER_ID).nullable();
    table.string('action', { length: 64 }).notNull();
    table.json('details').nullable();
    table.datetimeTz('createdAt').notNull();
    table.index('issueId', { name: 'np_activities_issue_idx' });
  });
}

async function createAgentCollections(builder: Builder): Promise<void> {
  await builder.createCollection('runtimes', (table) => {
    table.string('id', ID).primary();
    table.string('daemonId', { length: 128 }).notNull();
    table.string('provider', { length: 32 }).notNull();
    table.string('name', { length: 255 }).notNull();
    table.string('kind', { length: 16 }).notNull().defaultTo('personal');
    table.string('ownerUserId', USER_ID).notNull();
    table.string('visibility', { length: 16 }).notNull().defaultTo('private');
    table.string('status', { length: 16 }).notNull().defaultTo('offline');
    table.datetimeTz('lastSeenAt').nullable();
    table.string('version', { length: 64 }).nullable();
    table.json('capabilities').nullable();
    table.json('deviceInfo').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['daemonId', 'provider'], {
      name: 'np_runtimes_daemon_provider_unique',
    });
  });

  await builder.createCollection('agents', (table) => {
    table.string('id', ID).primary();
    table.string('name', { length: 255 }).notNull();
    table.text('description').nullable();
    table.string('ownerUserId', USER_ID).notNull();
    table.text('instructions').notNull();
    table.string('runtimeId', ID).nullable();
    table.string('provider', { length: 32 }).notNull();
    table.string('model', { length: 128 }).nullable();
    table.integer('maxConcurrentRuns').notNull().defaultTo(6);
    table.string('access', { length: 16 }).notNull().defaultTo('ownerOnly');
    table.datetimeTz('archivedAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index('runtimeId', { name: 'np_agents_runtime_idx' });
  });
}

async function createRunCollections(builder: Builder): Promise<void> {
  await builder.createCollection('runs', (table) => {
    table.string('id', ID).primary();
    table.string('agentId', ID).notNull();
    table.string('runtimeId', ID).nullable();
    table.string('kind', { length: 16 }).notNull().defaultTo('issue');
    table.string('status', { length: 16 }).notNull();
    table.integer('priority').notNull().defaultTo(0);
    table.integer('attempt').notNull().defaultTo(1);
    table.integer('maxAttempts').notNull().defaultTo(2);
    table.string('retryOfRunId', ID).nullable();
    table.string('subjectType', { length: 16 }).notNull();
    table.string('subjectId', ID).notNull();
    table.string('threadScope', ID).nullable();
    table.string('actorUserId', USER_ID).nullable();
    table.string('ownerUserId', USER_ID).nullable();
    table.datetimeTz('fireAt').nullable();
    table.datetimeTz('leaseExpiresAt').nullable();
    table.datetimeTz('dispatchedAt').nullable();
    table.datetimeTz('startedAt').nullable();
    table.datetimeTz('finishedAt').nullable();
    table.string('failureReason', { length: 64 }).nullable();
    table.text('failureDetail').nullable();
    table.datetimeTz('cancelRequestedAt').nullable();
    table.string('cancelledById', USER_ID).nullable();
    table.text('resultSummary').nullable();
    table.string('providerSessionId', { length: 255 }).nullable();
    table.text('workDir').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index('status', { name: 'np_runs_status_idx' });
    table.index(['agentId', 'status'], { name: 'np_runs_agent_status_idx' });
    table.index(['runtimeId', 'status'], {
      name: 'np_runs_runtime_status_idx',
    });
    table.index(['subjectType', 'subjectId'], {
      name: 'np_runs_subject_idx',
    });
  });

  await builder.createCollection('runTriggers', (table) => {
    table.string('id', ID).primary();
    table.string('runId', ID).notNull();
    table.string('type', { length: 32 }).notNull();
    table.string('commentId', ID).nullable();
    table.json('payload').nullable();
    table.string('createdById', USER_ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.index('runId', { name: 'np_run_triggers_run_idx' });
  });

  await builder.createCollection('runSessions', (table) => {
    table.string('id', ID).primary();
    table.string('agentId', ID).notNull();
    table.string('runtimeId', ID).notNull();
    table.string('subjectType', { length: 16 }).notNull();
    table.string('subjectId', ID).notNull();
    table.string('providerSessionId', { length: 255 }).nullable();
    table.text('workDir').nullable();
    table.boolean('poisoned').notNull().defaultTo(false);
    table.string('lastRunId', ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['agentId', 'runtimeId', 'subjectType', 'subjectId'], {
      name: 'np_run_sessions_unique',
    });
  });

  await builder.createCollection('runEvents', (table) => {
    table.string('id', ID).primary();
    table.string('runId', ID).notNull();
    table.integer('seq').notNull();
    table.string('type', { length: 32 }).notNull();
    table.string('tool', { length: 255 }).nullable();
    table.text('content').nullable();
    table.json('input').nullable();
    table.text('output').nullable();
    table.boolean('truncated').notNull().defaultTo(false);
    table.datetimeTz('at').notNull();
    table.unique(['runId', 'seq'], { name: 'np_run_events_run_seq_unique' });
  });

  await builder.createCollection('runUsage', (table) => {
    table.string('id', ID).primary();
    table.string('runId', ID).notNull();
    table.string('provider', { length: 32 }).notNull();
    table.string('model', { length: 128 }).nullable();
    table.integer('inputTokens').notNull().defaultTo(0);
    table.integer('outputTokens').notNull().defaultTo(0);
    table.integer('cacheReadTokens').notNull().defaultTo(0);
    table.integer('cacheWriteTokens').notNull().defaultTo(0);
    table.datetimeTz('createdAt').notNull();
    table.index('runId', { name: 'np_run_usage_run_idx' });
  });

  await builder.createCollection('runTokens', (table) => {
    table.string('id', ID).primary();
    table.string('hash', { length: 64 }).notNull();
    table.string('runId', ID).notNull();
    table.string('agentId', ID).notNull();
    table.string('actorUserId', USER_ID).nullable();
    table.datetimeTz('expiresAt').notNull();
    table.datetimeTz('revokedAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.unique('hash', { name: 'np_run_tokens_hash_unique' });
    table.index('runId', { name: 'np_run_tokens_run_idx' });
  });
}

const migration: MigrationDefinition = defineMigration({
  name: '2026092700001_np_phase0',

  async up({ builder, connection }) {
    await createIssueCollections(builder);
    await createAgentCollections(builder);
    await createRunCollections(builder);

    const pg = await postgresClient(connection);
    if (pg) {
      await pg.raw(
        `CREATE UNIQUE INDEX ${PENDING_RUN_INDEX} ON runs ` +
          `(agent_id, subject_type, subject_id, COALESCE(thread_scope, '')) ` +
          `WHERE status IN ('queued', 'deferred', 'dispatched')`,
      );
    }
    // Other dialects skip the partial index: the enqueue path still coalesces by lookup, but without the database
    // guarantee against two concurrent enqueues. Phase 0 only verifies PostgreSQL.
  },

  async down({ builder, connection }) {
    const pg = await postgresClient(connection);
    if (pg) {
      await pg.raw(`DROP INDEX IF EXISTS ${PENDING_RUN_INDEX}`);
    }
    await builder.dropCollection('runTokens');
    await builder.dropCollection('runUsage');
    await builder.dropCollection('runEvents');
    await builder.dropCollection('runSessions');
    await builder.dropCollection('runTriggers');
    await builder.dropCollection('runs');
    await builder.dropCollection('agents');
    await builder.dropCollection('runtimes');
    await builder.dropCollection('activities');
    await builder.dropCollection('comments');
    await builder.dropCollection('issues');
    await builder.dropCollection('projects');
    await builder.dropCollection('systemSettings');
  },
});

export default migration;
