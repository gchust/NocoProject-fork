// NocoProject Phase 1 iteration 2 schema (docs/phase1/iteration-2-contract.md §A).
//
// New tables: gitConnections, pullRequests, issuePullRequests, webhookDeliveries, approvalRequests
// (@temporary(nocobase-official): 待替换为 NocoBase 官方 工作流审批), commentReactions, agentEnvVars, agentEnvAudits,
// skills, skillFiles, agentSkills, intakeBatches, intakeDrafts. New columns: issues.executionMode / originType /
// originId / deletedAt (soft delete for intake revert), comments.resolvedAt / resolvedById, and
// intakeBatches.sourceIssueId / parseError beyond the contract's list (see protocol-iteration-2.md §"与契约的出入").
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

// PostgreSQL-only partial unique index: one pending approval request per issue and target status.
const APPROVAL_PENDING_INDEX = 'np_approval_requests_pending_unique';

type Builder = MigrationContext['builder'];

async function postgresClient(
  connection: MigrationContext['connection'],
): Promise<Knex | undefined> {
  if (connection.dialect !== 'postgres') return undefined;
  return connection.client<Knex>();
}

async function createGitCollections(builder: Builder): Promise<void> {
  await builder.createCollection('gitConnections', (table) => {
    table.string('id', ID).primary();
    table.string('provider', { length: 16 }).notNull();
    table.string('name', { length: 255 }).notNull();
    table
      .string('apiBaseUrl', { length: 500 })
      .notNull()
      .defaultTo('https://api.github.com');
    table.text('tokenEncrypted').nullable();
    table.text('webhookSecretEncrypted').nullable();
    table.string('createdById', USER_ID).nullable();
    table.datetimeTz('lastEventAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique('provider', { name: 'np_git_connections_provider_unique' });
  });

  await builder.createCollection('pullRequests', (table) => {
    table.string('id', ID).primary();
    table.string('connectionId', ID).nullable();
    table.string('repo', { length: 255 }).notNull();
    table.integer('number').notNull();
    table.text('url').notNull();
    table.string('title', { length: 500 }).notNull().defaultTo('');
    table.string('state', { length: 16 }).notNull().defaultTo('open');
    table.boolean('draft').notNull().defaultTo(false);
    table.string('headRef', { length: 255 }).notNull().defaultTo('');
    table.string('baseRef', { length: 255 }).notNull().defaultTo('');
    table.string('headSha', { length: 64 }).notNull().defaultTo('');
    table.string('authorLogin', { length: 255 }).notNull().defaultTo('');
    table.integer('additions').notNull().defaultTo(0);
    table.integer('deletions').notNull().defaultTo(0);
    table.integer('changedFiles').notNull().defaultTo(0);
    table.string('mergeableState', { length: 32 }).nullable();
    table.string('ciState', { length: 16 }).nullable();
    table.datetimeTz('mergedAt').nullable();
    table.datetimeTz('closedAt').nullable();
    table.datetimeTz('snapshotAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['repo', 'number'], {
      name: 'np_pull_requests_repo_number_unique',
    });
    table.index('headSha', { name: 'np_pull_requests_head_sha_idx' });
  });

  await builder.createCollection('issuePullRequests', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('pullRequestId', ID).notNull();
    table.string('linkedByType', { length: 16 }).notNull();
    table.string('linkedById', USER_ID).nullable();
    table.boolean('autoCompleteDisabled').notNull().defaultTo(false);
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['issueId', 'pullRequestId'], {
      name: 'np_issue_pull_requests_unique',
    });
    table.index('pullRequestId', { name: 'np_issue_pull_requests_pr_idx' });
  });

  await builder.createCollection('webhookDeliveries', (table) => {
    table.string('id', ID).primary();
    table.string('provider', { length: 16 }).notNull();
    table.string('deliveryId', { length: 128 }).notNull();
    table.datetimeTz('receivedAt').notNull();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['provider', 'deliveryId'], {
      name: 'np_webhook_deliveries_unique',
    });
    table.index('receivedAt', { name: 'np_webhook_deliveries_received_idx' });
  });
}

async function createCollaborationCollections(builder: Builder): Promise<void> {
  // @temporary(nocobase-official): 待替换为 NocoBase 官方 工作流审批
  await builder.createCollection('approvalRequests', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('fromStatus', { length: 32 }).notNull();
    table.string('toStatus', { length: 32 }).notNull();
    table.string('requestedByType', { length: 16 }).notNull();
    table.string('requestedById', USER_ID).notNull();
    table.string('requestedRunId', ID).nullable();
    table.json('approverUserIds').notNull();
    table.string('status', { length: 16 }).notNull().defaultTo('pending');
    table.string('decidedById', USER_ID).nullable();
    table.datetimeTz('decidedAt').nullable();
    table.text('comment').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index(['issueId', 'status'], {
      name: 'np_approval_requests_issue_status_idx',
    });
  });

  await builder.createCollection('commentReactions', (table) => {
    table.string('id', ID).primary();
    table.string('commentId', ID).notNull();
    table.string('userId', USER_ID).notNull();
    table.string('emoji', { length: 32 }).notNull();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['commentId', 'userId', 'emoji'], {
      name: 'np_comment_reactions_unique',
    });
  });
}

async function createAgentCollections(builder: Builder): Promise<void> {
  await builder.createCollection('agentEnvVars', (table) => {
    table.string('id', ID).primary();
    table.string('agentId', ID).notNull();
    table.string('name', { length: 128 }).notNull();
    table.text('valueEncrypted').notNull();
    table.string('updatedById', USER_ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['agentId', 'name'], { name: 'np_agent_env_vars_unique' });
  });

  await builder.createCollection('agentEnvAudits', (table) => {
    table.string('id', ID).primary();
    table.string('agentId', ID).notNull();
    table.string('userId', USER_ID).notNull();
    table.string('action', { length: 16 }).notNull();
    table.json('names').notNull();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index(['agentId', 'createdAt'], {
      name: 'np_agent_env_audits_agent_idx',
    });
  });

  await builder.createCollection('skills', (table) => {
    table.string('id', ID).primary();
    table.string('name', { length: 255 }).notNull();
    table.string('slug', { length: 128 }).notNull();
    table.text('description').nullable();
    table.text('content').nullable();
    table.string('source', { length: 16 }).notNull().defaultTo('manual');
    table.string('createdById', USER_ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique('slug', { name: 'np_skills_slug_unique' });
  });

  await builder.createCollection('skillFiles', (table) => {
    table.string('id', ID).primary();
    table.string('skillId', ID).notNull();
    table.string('path', { length: 255 }).notNull();
    table.text('content').notNull();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['skillId', 'path'], { name: 'np_skill_files_unique' });
  });

  await builder.createCollection('agentSkills', (table) => {
    table.string('id', ID).primary();
    table.string('agentId', ID).notNull();
    table.string('skillId', ID).notNull();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['agentId', 'skillId'], { name: 'np_agent_skills_unique' });
    table.index('skillId', { name: 'np_agent_skills_skill_idx' });
  });
}

async function createIntakeCollections(builder: Builder): Promise<void> {
  await builder.createCollection('intakeBatches', (table) => {
    table.string('id', ID).primary();
    table.string('createdById', USER_ID).notNull();
    table.string('projectId', ID).nullable();
    table.string('source', { length: 16 }).notNull();
    table.string('sourceIssueId', ID).nullable();
    table.text('rawContent').notNull();
    table.string('parser', { length: 16 }).notNull();
    table.text('parseError').nullable();
    table.string('status', { length: 16 }).notNull().defaultTo('draft');
    table.string('aiSessionId', { length: 128 }).nullable();
    table.datetimeTz('confirmedAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index(['createdById', 'createdAt'], {
      name: 'np_intake_batches_creator_idx',
    });
  });

  await builder.createCollection('intakeDrafts', (table) => {
    table.string('id', ID).primary();
    table.string('batchId', ID).notNull();
    table.integer('position').notNull();
    table.integer('parentPosition').nullable();
    table.json('fields').notNull();
    table.json('validation').notNull();
    table.string('createdIssueId', ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['batchId', 'position'], { name: 'np_intake_drafts_unique' });
  });
}

async function addColumns(builder: Builder): Promise<void> {
  await builder.alterCollection('issues', (table) => {
    table.string('executionMode', { length: 16 }).notNull().defaultTo('task');
    table.string('originType', { length: 16 }).notNull().defaultTo('manual');
    table.string('originId', ID).nullable();
    table.datetimeTz('deletedAt').nullable();
  });
  await builder.alterCollection('comments', (table) => {
    table.datetimeTz('resolvedAt').nullable();
    table.string('resolvedById', USER_ID).nullable();
  });
}

async function dropColumns(builder: Builder): Promise<void> {
  await builder.alterCollection('comments', (table) => {
    table.dropFields('resolvedAt', 'resolvedById');
  });
  await builder.alterCollection('issues', (table) => {
    table.dropFields('executionMode', 'originType', 'originId', 'deletedAt');
  });
}

const migration: MigrationDefinition = defineMigration({
  name: '2026092900001_np_phase1_iter2',

  async up({ builder, connection, query }) {
    await createGitCollections(builder);
    await createCollaborationCollections(builder);
    await createAgentCollections(builder);
    await createIntakeCollections(builder);
    await addColumns(builder);

    // Sub-issues an agent created before this migration: their `issue_created` activity names an agent actor.
    const agentCreated = await query
      .selectFrom('activities')
      .select('issueId')
      .where('action', '=', 'issue_created')
      .where('actorType', '=', 'agent')
      .execute();
    const ids = agentCreated.map((row) => String(row.issueId as string));
    for (let index = 0; index < ids.length; index += 500) {
      await query
        .updateTable('issues')
        .set({ originType: 'agent' })
        .where('id', 'in', ids.slice(index, index + 500))
        .execute();
    }

    const pg = await postgresClient(connection);
    if (pg) {
      await pg.raw(
        `CREATE UNIQUE INDEX ${APPROVAL_PENDING_INDEX} ON approval_requests (issue_id, to_status) ` +
          `WHERE status = 'pending'`,
      );
    }
    // Other dialects skip the partial index: the gateway still refuses a second pending request by lookup.
  },

  async down({ builder, connection }) {
    const pg = await postgresClient(connection);
    if (pg) await pg.raw(`DROP INDEX IF EXISTS ${APPROVAL_PENDING_INDEX}`);
    await dropColumns(builder);
    await builder.dropCollection('intakeDrafts');
    await builder.dropCollection('intakeBatches');
    await builder.dropCollection('agentSkills');
    await builder.dropCollection('skillFiles');
    await builder.dropCollection('skills');
    await builder.dropCollection('agentEnvAudits');
    await builder.dropCollection('agentEnvVars');
    await builder.dropCollection('commentReactions');
    await builder.dropCollection('approvalRequests');
    await builder.dropCollection('webhookDeliveries');
    await builder.dropCollection('issuePullRequests');
    await builder.dropCollection('pullRequests');
    await builder.dropCollection('gitConnections');
  },
});

export default migration;
