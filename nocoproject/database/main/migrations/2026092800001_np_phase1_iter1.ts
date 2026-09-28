// NocoProject Phase 1 iteration 1 schema (docs/phase1/iteration-1-contract.md §A).
//
// New tables: members, projectMembers, projectResources, workflowTemplates (the contract's `workflows`; that table
// name belongs to the workflow plugin), issueLabels, issueLabelLinks, issueDependencies, executorProposals,
// issueSubscribers, inboxItems, agentAccessGrants, agentDelegationGrants. New columns on projects, issues, runs,
// runSessions and systemSettings. `agents.access` keeps its column; the new value
// 'specificUsers' fits the existing length and old values stay as they are.
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
const DATE = { length: 10 } as const;

// PostgreSQL-only partial unique indexes (the Collection Builder cannot express them portably; Phase 0 did the same):
// one unresolved inbox item per dedupe key, and at most one default workflow.
const INBOX_DEDUPE_INDEX = 'np_inbox_items_dedupe_unique';
const DEFAULT_WORKFLOW_INDEX = 'np_workflow_templates_default_unique';

const SETTINGS_DEFAULTS = {
  autoExecuteSubtasksDefault: false,
  prMergedStatus: 'done',
};

type Builder = MigrationContext['builder'];

async function postgresClient(
  connection: MigrationContext['connection'],
): Promise<Knex | undefined> {
  if (connection.dialect !== 'postgres') return undefined;
  return connection.client<Knex>();
}

async function createMemberCollections(builder: Builder): Promise<void> {
  await builder.createCollection('members', (table) => {
    table.string('id', ID).primary();
    table.string('userId', USER_ID).notNull();
    table.string('role', { length: 16 }).notNull().defaultTo('member');
    table.datetimeTz('joinedAt').notNull();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique('userId', { name: 'np_members_user_unique' });
  });

  await builder.createCollection('projectMembers', (table) => {
    table.string('id', ID).primary();
    table.string('projectId', ID).notNull();
    table.string('userId', USER_ID).notNull();
    table.string('role', { length: 16 }).notNull().defaultTo('member');
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['projectId', 'userId'], {
      name: 'np_project_members_unique',
    });
    table.index('userId', { name: 'np_project_members_user_idx' });
  });

  await builder.createCollection('projectResources', (table) => {
    table.string('id', ID).primary();
    table.string('projectId', ID).notNull();
    table.string('type', { length: 16 }).notNull();
    table.json('ref').notNull();
    table.string('label', { length: 255 }).nullable();
    table.integer('position').notNull().defaultTo(0);
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index('projectId', { name: 'np_project_resources_project_idx' });
  });

  await builder.createCollection('workflowTemplates', (table) => {
    table.string('id', ID).primary();
    table.string('name', { length: 255 }).notNull();
    table.boolean('isDefault').notNull().defaultTo(false);
    table.json('definition').notNull();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
  });
}

async function createIssueCollections(builder: Builder): Promise<void> {
  await builder.createCollection('issueLabels', (table) => {
    table.string('id', ID).primary();
    table.string('name', { length: 64 }).notNull();
    table.string('color', { length: 16 }).notNull().defaultTo('gray');
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique('name', { name: 'np_issue_labels_name_unique' });
  });

  await builder.createCollection('issueLabelLinks', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('labelId', ID).notNull();
    table.datetimeTz('createdAt').notNull();
    table.unique(['issueId', 'labelId'], {
      name: 'np_issue_label_links_unique',
    });
    table.index('labelId', { name: 'np_issue_label_links_label_idx' });
  });

  // Self-reference and direct mutual reference are rejected by the service (with a DFS cycle check on blockedBy).
  await builder.createCollection('issueDependencies', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('dependsOnIssueId', ID).notNull();
    table.string('type', { length: 16 }).notNull().defaultTo('blockedBy');
    table.string('createdByType', { length: 16 }).notNull();
    table.string('createdById', USER_ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.unique(['issueId', 'dependsOnIssueId', 'type'], {
      name: 'np_issue_dependencies_unique',
    });
    table.index('dependsOnIssueId', {
      name: 'np_issue_dependencies_target_idx',
    });
  });

  await builder.createCollection('executorProposals', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('proposedAgentId', ID).notNull();
    table.string('proposedByAgentId', ID).notNull();
    table.string('sourceRunId', ID).nullable();
    table.string('status', { length: 16 }).notNull().defaultTo('pending');
    table.string('decidedById', USER_ID).nullable();
    table.datetimeTz('decidedAt').nullable();
    table.text('reason').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index(['issueId', 'status'], {
      name: 'np_executor_proposals_issue_status_idx',
    });
  });

  await builder.createCollection('issueSubscribers', (table) => {
    table.string('id', ID).primary();
    table.string('issueId', ID).notNull();
    table.string('userId', USER_ID).notNull();
    table.string('reason', { length: 16 }).notNull();
    table.datetimeTz('unsubscribedAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['issueId', 'userId'], {
      name: 'np_issue_subscribers_unique',
    });
    table.index('userId', { name: 'np_issue_subscribers_user_idx' });
  });

  await builder.createCollection('inboxItems', (table) => {
    table.string('id', ID).primary();
    table.string('userId', USER_ID).notNull();
    table.string('kind', { length: 16 }).notNull();
    table.string('type', { length: 32 }).notNull();
    table.string('issueId', ID).nullable();
    table.string('title', { length: 500 }).notNull();
    table.text('body').nullable();
    table.string('actorType', { length: 16 }).nullable();
    table.string('actorId', USER_ID).nullable();
    table.string('actorName', { length: 255 }).nullable();
    table.integer('count').notNull().defaultTo(1);
    table.string('dedupeKey', { length: 255 }).notNull();
    table.datetimeTz('readAt').nullable();
    table.datetimeTz('archivedAt').nullable();
    table.datetimeTz('resolvedAt').nullable();
    table.json('payload').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index(['userId', 'kind', 'archivedAt'], {
      name: 'np_inbox_items_user_kind_idx',
    });
    table.index('issueId', { name: 'np_inbox_items_issue_idx' });
  });
}

async function createAgentCollections(builder: Builder): Promise<void> {
  await builder.createCollection('agentAccessGrants', (table) => {
    table.string('id', ID).primary();
    table.string('agentId', ID).notNull();
    table.string('userId', USER_ID).notNull();
    table.datetimeTz('createdAt').notNull();
    table.unique(['agentId', 'userId'], {
      name: 'np_agent_access_grants_unique',
    });
  });

  await builder.createCollection('agentDelegationGrants', (table) => {
    table.string('id', ID).primary();
    table.string('agentId', ID).notNull();
    table.string('targetAgentId', ID).notNull();
    table.string('grantedById', USER_ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.unique(['agentId', 'targetAgentId'], {
      name: 'np_agent_delegation_grants_unique',
    });
  });
}

async function addColumns(builder: Builder): Promise<void> {
  await builder.alterCollection('projects', (table) => {
    table.string('visibility', { length: 16 }).notNull().defaultTo('everyone');
    table.string('leadUserId', USER_ID).nullable();
    table.string('status', { length: 16 }).notNull().defaultTo('planned');
    table.string('priority', { length: 16 }).notNull().defaultTo('none');
    table.string('startDate', DATE).nullable();
    table.string('dueDate', DATE).nullable();
    table.string('workflowId', ID).nullable();
  });

  await builder.alterCollection('issues', (table) => {
    table.integer('stage').nullable();
    table.string('startDate', DATE).nullable();
    table.string('dueDate', DATE).nullable();
    table.boolean('autoExecuteSubtasks').notNull().defaultTo(false);
    table.string('suggestedExecutorAgentId', ID).nullable();
    table.index('parentIssueId', { name: 'np_issues_parent_idx' });
    table.index('projectId', { name: 'np_issues_project_idx' });
  });

  await builder.alterCollection('runs', (table) => {
    table.string('branchName', { length: 255 }).nullable();
    table.text('repoUrl').nullable();
  });

  await builder.alterCollection('runSessions', (table) => {
    table.string('branchName', { length: 255 }).nullable();
    table.text('repoUrl').nullable();
  });

  await builder.alterCollection('systemSettings', (table) => {
    table.json('settings').nullable();
  });
}

async function dropColumns(builder: Builder): Promise<void> {
  await builder.alterCollection('systemSettings', (table) => {
    table.dropField('settings');
  });
  await builder.alterCollection('runSessions', (table) => {
    table.dropFields('branchName', 'repoUrl');
  });
  await builder.alterCollection('runs', (table) => {
    table.dropFields('branchName', 'repoUrl');
  });
  await builder.alterCollection('issues', (table) => {
    table.dropIndex('np_issues_parent_idx');
    table.dropIndex('np_issues_project_idx');
    table.dropFields(
      'stage',
      'startDate',
      'dueDate',
      'autoExecuteSubtasks',
      'suggestedExecutorAgentId',
    );
  });
  await builder.alterCollection('projects', (table) => {
    table.dropFields(
      'visibility',
      'leadUserId',
      'status',
      'priority',
      'startDate',
      'dueDate',
      'workflowId',
    );
  });
}

const migration: MigrationDefinition = defineMigration({
  name: '2026092800001_np_phase1_iter1',

  async up({ builder, connection, query }) {
    await createMemberCollections(builder);
    await createIssueCollections(builder);
    await createAgentCollections(builder);
    await addColumns(builder);

    // Backfill the new settings json on the existing settings row (JSON columns are written as serialized text,
    // like every NocoProject JSON write).
    await query
      .updateTable('systemSettings')
      .set({ settings: JSON.stringify(SETTINGS_DEFAULTS) })
      .where('settings', 'is', null)
      .execute();

    const pg = await postgresClient(connection);
    if (pg) {
      await pg.raw(
        `CREATE UNIQUE INDEX ${INBOX_DEDUPE_INDEX} ON inbox_items (dedupe_key) WHERE resolved_at IS NULL`,
      );
      await pg.raw(
        `CREATE UNIQUE INDEX ${DEFAULT_WORKFLOW_INDEX} ON workflow_templates (is_default) WHERE is_default`,
      );
    }
    // Other dialects skip the partial indexes: inbox dedupe still merges by lookup, without the database guarantee
    // against two concurrent inserts of the same key.
  },

  async down({ builder, connection }) {
    const pg = await postgresClient(connection);
    if (pg) {
      await pg.raw(`DROP INDEX IF EXISTS ${DEFAULT_WORKFLOW_INDEX}`);
      await pg.raw(`DROP INDEX IF EXISTS ${INBOX_DEDUPE_INDEX}`);
    }
    await dropColumns(builder);
    await builder.dropCollection('agentDelegationGrants');
    await builder.dropCollection('agentAccessGrants');
    await builder.dropCollection('inboxItems');
    await builder.dropCollection('issueSubscribers');
    await builder.dropCollection('executorProposals');
    await builder.dropCollection('issueDependencies');
    await builder.dropCollection('issueLabelLinks');
    await builder.dropCollection('issueLabels');
    await builder.dropCollection('workflowTemplates');
    await builder.dropCollection('projectResources');
    await builder.dropCollection('projectMembers');
    await builder.dropCollection('members');
  },
});

export default migration;
