// NocoProject Phase 1 iteration 3 schema (docs/phase1/iteration-3-contract.md §A).
//
// New tables: knowledgeDocs, knowledgeDocVersions, knowledgeProposals. System-level documents store `projectId = ''`
// so that unique(projectId, slug) holds for them too (the API reports null). knowledgeProposals.baseVersion (the
// document version a proposal was written against) is beyond the contract's list.
//
// New indexes for the paginated lists (§D): issues (projectId, statusKey, updatedAt), (ownerUserId, statusKey),
// (executorType, executorId, statusKey) and, beyond the contract, (updatedAt, id) for the default unfiltered list
// order; activities (issueId, createdAt desc); inboxItems (userId, kind, resolvedAt, createdAt desc).
//
// Self-contained on purpose: every field, index and constraint is spelled out here and nothing is imported from
// server/modules, so the meaning of this migration never changes after it has run.
import {
  defineMigration,
  type MigrationContext,
  type MigrationDefinition,
} from '@nocobase/db';

const ID = { length: 32 } as const;
const USER_ID = { length: 64 } as const;

type Builder = MigrationContext['builder'];

async function createKnowledgeCollections(builder: Builder): Promise<void> {
  await builder.createCollection('knowledgeDocs', (table) => {
    table.string('id', ID).primary();
    // '' = system-level document.
    table.string('projectId', ID).notNull().defaultTo('');
    table.string('title', { length: 200 }).notNull();
    table.string('slug', { length: 64 }).notNull();
    table.string('summary', { length: 300 }).notNull().defaultTo('');
    table.text('content').notNull();
    table.integer('version').notNull().defaultTo(1);
    table.string('updatedByType', { length: 16 }).notNull();
    table.string('updatedById', USER_ID).nullable();
    table.datetimeTz('archivedAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['projectId', 'slug'], {
      name: 'np_knowledge_docs_project_slug_unique',
    });
    table.index('projectId', { name: 'np_knowledge_docs_project_idx' });
  });

  await builder.createCollection('knowledgeDocVersions', (table) => {
    table.string('id', ID).primary();
    table.string('docId', ID).notNull();
    table.integer('version').notNull();
    table.string('title', { length: 200 }).notNull();
    table.text('content').notNull();
    table.string('summary', { length: 300 }).notNull().defaultTo('');
    table.string('authorType', { length: 16 }).notNull();
    table.string('authorId', USER_ID).nullable();
    table.string('sourceRunId', ID).nullable();
    table.string('proposalId', ID).nullable();
    table.text('note').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.unique(['docId', 'version'], {
      name: 'np_knowledge_doc_versions_unique',
    });
  });

  await builder.createCollection('knowledgeProposals', (table) => {
    table.string('id', ID).primary();
    table.string('docId', ID).nullable();
    table.string('projectId', ID).nullable();
    table.string('title', { length: 200 }).notNull().defaultTo('');
    table.string('slug', { length: 64 }).nullable();
    table.string('summary', { length: 300 }).notNull().defaultTo('');
    table.text('content').notNull();
    table.string('reason', { length: 500 }).notNull();
    table.integer('baseVersion').nullable();
    table.string('proposedByAgentId', ID).notNull();
    table.string('sourceRunId', ID).nullable();
    table.string('sourceIssueId', ID).nullable();
    table.string('status', { length: 16 }).notNull().defaultTo('pending');
    table.string('decidedById', USER_ID).nullable();
    table.datetimeTz('decidedAt').nullable();
    table.text('comment').nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index(['status', 'projectId'], {
      name: 'np_knowledge_proposals_status_project_idx',
    });
    table.index(['docId', 'status'], {
      name: 'np_knowledge_proposals_doc_status_idx',
    });
  });
}

async function addIndexes(builder: Builder): Promise<void> {
  await builder.alterCollection('issues', (table) => {
    table.index(['projectId', 'statusKey', 'updatedAt'], {
      name: 'np_issues_project_status_updated_idx',
    });
    table.index(['ownerUserId', 'statusKey'], {
      name: 'np_issues_owner_status_idx',
    });
    table.index(['executorType', 'executorId', 'statusKey'], {
      name: 'np_issues_executor_status_idx',
    });
    table.index(['updatedAt', 'id'], { name: 'np_issues_updated_idx' });
  });
  await builder.alterCollection('activities', (table) => {
    table.index(['issueId', 'createdAt'], {
      name: 'np_activities_issue_created_idx',
      order: { createdAt: 'desc' },
    });
  });
  await builder.alterCollection('inboxItems', (table) => {
    table.index(['userId', 'kind', 'resolvedAt', 'createdAt'], {
      name: 'np_inbox_items_user_kind_resolved_idx',
      order: { createdAt: 'desc' },
    });
  });
}

async function dropIndexes(builder: Builder): Promise<void> {
  await builder.alterCollection('inboxItems', (table) => {
    table.dropIndex('np_inbox_items_user_kind_resolved_idx');
  });
  await builder.alterCollection('activities', (table) => {
    table.dropIndex('np_activities_issue_created_idx');
  });
  await builder.alterCollection('issues', (table) => {
    table.dropIndex('np_issues_updated_idx');
    table.dropIndex('np_issues_executor_status_idx');
    table.dropIndex('np_issues_owner_status_idx');
    table.dropIndex('np_issues_project_status_updated_idx');
  });
}

const migration: MigrationDefinition = defineMigration({
  name: '2026093000001_np_phase1_iter3',

  async up({ builder }) {
    await createKnowledgeCollections(builder);
    await addIndexes(builder);
  },

  async down({ builder }) {
    await dropIndexes(builder);
    await builder.dropCollection('knowledgeProposals');
    await builder.dropCollection('knowledgeDocVersions');
    await builder.dropCollection('knowledgeDocs');
  },
});

export default migration;
