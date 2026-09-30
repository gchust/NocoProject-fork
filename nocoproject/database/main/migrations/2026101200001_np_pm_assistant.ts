// NocoProject: the project manager assistant (NP-181 PM 2.0, NP-183; docs/phase2/protocol-pm-assistant.md §1).
//
// - issues: `number` and `identifier` become nullable; only project manager conversations leave them empty (new
//   conversations take no NP-n number). The unique index on `number` allows any number of NULLs.
// - comments: `context` (the page context of a conversation message), `via` ('pm': written by the project manager in
//   the asker's name). `kind` also takes 'plan' and 'plan_result', which fit the existing column.
// - agents: `summary` ("what it is good at", at most 200 characters).
// - runtimes: `pmAllowed` (a public runtime may run personal project managers).
// - members: the project manager preferences next to NP-108's `inboxChime` (`pmConfirmAll`, `pmAgentMode`,
//   `pmAgentId`) and `preferencesRevision`.
// - pmConversations: one row per conversation issue (owner, bound agent, title source, archive).
// - pmPlans / pmPlanOps: operation plan cards and their rows.
// - pmActWrites: the objects each conversation run wrote directly (the per-run budget).
// - systemSettings.agentEntries.conversation gains `allowPersonal` (absent = false); nothing is written for it.
//
// Backfill (idempotent): a pmConversations row for every live `originType = 'pm'` issue, bound to its current
// executor as the system project manager. Nothing existing is deleted or rewritten.
//
// `down` drops what `up` added; it refuses while an issue has no number (fix forward instead).
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import {
  defineMigration,
  type MigrationContext,
  type MigrationDefinition,
} from '@nocobase/db';

const ID = { length: 32 } as const;
const USER_ID = { length: 64 } as const;

type Builder = MigrationContext['builder'];

async function createConversationTables(builder: Builder): Promise<void> {
  await builder.createCollection('pmConversations', (table) => {
    table.string('issueId', ID).primary();
    table.string('ownerUserId', USER_ID).notNull();
    table.string('agentId', ID).nullable();
    table.string('agentSource', { length: 16 }).notNull().defaultTo('system');
    table.string('personalAgentId', ID).nullable();
    table.string('titleSource', { length: 16 }).notNull().defaultTo('auto');
    table.datetimeTz('lastMessageAt').notNull();
    table.datetimeTz('archivedAt').nullable();
    table.datetimeTz('createdAt').notNull();
    table.index(['ownerUserId', 'archivedAt', 'lastMessageAt'], {
      name: 'np_pm_conversations_owner_idx',
    });
  });
  await builder.createCollection('pmActWrites', (table) => {
    table.string('id', ID).primary();
    table.string('runId', ID).notNull();
    table.string('opType', { length: 32 }).notNull();
    table.string('objectType', { length: 32 }).notNull();
    table.string('objectId', ID).notNull();
    table.datetimeTz('createdAt').notNull();
    table.index(['runId'], { name: 'np_pm_act_writes_run_idx' });
  });
}

async function createPlanTables(builder: Builder): Promise<void> {
  await builder.createCollection('pmPlans', (table) => {
    table.string('id', ID).primary();
    table.string('conversationIssueId', ID).notNull();
    table.string('runId', ID).nullable();
    table.string('agentId', ID).nullable();
    table.string('ownerUserId', USER_ID).notNull();
    table.string('title', { length: 200 }).notNull();
    table.text('summary').nullable();
    table.string('status', { length: 16 }).notNull().defaultTo('pending');
    table.integer('revision').notNull().defaultTo(1);
    table.datetimeTz('expiresAt').notNull();
    table.datetimeTz('executedAt').nullable();
    table.string('executedById', USER_ID).nullable();
    table.json('result').nullable();
    table.string('commentId', ID).nullable();
    table.datetimeTz('createdAt').notNull();
    table.datetimeTz('updatedAt').notNull();
    table.index(['conversationIssueId', 'status'], {
      name: 'np_pm_plans_conversation_idx',
    });
  });
  await builder.createCollection('pmPlanOps', (table) => {
    table.string('id', ID).primary();
    table.string('planId', ID).notNull();
    table.integer('seq').notNull();
    table.string('ref', { length: 16 }).nullable();
    table.string('type', { length: 32 }).notNull();
    table.json('params').notNull();
    table.json('baseline').nullable();
    table.string('status', { length: 16 }).notNull().defaultTo('pending');
    table.string('errorCode', { length: 64 }).nullable();
    table.text('errorMessage').nullable();
    table.json('preview').nullable();
    table.string('resultType', { length: 32 }).nullable();
    table.string('resultId', ID).nullable();
    table.json('warnings').nullable();
    table.unique(['planId', 'seq'], { name: 'np_pm_plan_ops_seq_unique' });
  });
}

async function addColumns(builder: Builder): Promise<void> {
  await builder.alterField('issues', 'number', {
    type: 'integer',
    nullable: true,
  });
  await builder.alterField('issues', 'identifier', {
    type: 'string',
    length: 32,
    nullable: true,
  });
  await builder.alterCollection('comments', (table) => {
    table.json('context').nullable();
    table.string('via', { length: 16 }).nullable();
  });
  await builder.alterCollection('agents', (table) => {
    table.string('summary', { length: 200 }).nullable();
  });
  await builder.alterCollection('runtimes', (table) => {
    table.boolean('pmAllowed').notNull().defaultTo(false);
  });
  await builder.alterCollection('members', (table) => {
    table.boolean('pmConfirmAll').notNull().defaultTo(false);
    table.string('pmAgentMode', { length: 16 }).notNull().defaultTo('system');
    table.string('pmAgentId', ID).nullable();
    table.integer('preferencesRevision').notNull().defaultTo(1);
  });
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const migration: MigrationDefinition = defineMigration({
  name: '2026101200001_np_pm_assistant',

  async up({ builder, query }) {
    await addColumns(builder);
    await createConversationTables(builder);
    await createPlanTables(builder);
    const conversations = await query
      .selectFrom('issues')
      .select(['id', 'ownerUserId', 'executorId', 'createdAt'])
      .where('originType', '=', 'pm')
      .where('deletedAt', 'is', null)
      .execute();
    for (const issue of conversations) {
      const existing = await query
        .selectFrom('pmConversations')
        .select('issueId')
        .where('issueId', '=', issue.id)
        .executeTakeFirst();
      if (existing) continue;
      const latest = await query
        .selectFrom('comments')
        .select('createdAt')
        .where('issueId', '=', issue.id)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .executeTakeFirst();
      await query
        .insertInto('pmConversations')
        .values({
          issueId: issue.id,
          ownerUserId: issue.ownerUserId,
          agentId: issue.executorId ?? null,
          agentSource: 'system',
          personalAgentId: null,
          titleSource: 'auto',
          lastMessageAt: iso(latest?.createdAt ?? issue.createdAt),
          archivedAt: null,
          createdAt: iso(issue.createdAt),
        })
        .execute();
    }
  },

  async down({ builder, query }) {
    const unnumbered = await query
      .selectFrom('issues')
      .select('id')
      .where('number', 'is', null)
      .limit(1)
      .executeTakeFirst();
    if (unnumbered)
      throw new Error(
        'Issues without a number exist (project manager conversations); fix forward instead of rolling back.',
      );
    await builder.dropCollection('pmPlanOps');
    await builder.dropCollection('pmPlans');
    await builder.dropCollection('pmActWrites');
    await builder.dropCollection('pmConversations');
    await builder.alterCollection('members', (table) => {
      table.dropFields(
        'pmConfirmAll',
        'pmAgentMode',
        'pmAgentId',
        'preferencesRevision',
      );
    });
    await builder.alterCollection('runtimes', (table) => {
      table.dropFields('pmAllowed');
    });
    await builder.alterCollection('agents', (table) => {
      table.dropFields('summary');
    });
    await builder.alterCollection('comments', (table) => {
      table.dropFields('context', 'via');
    });
    await builder.alterField('issues', 'identifier', {
      type: 'string',
      length: 32,
      nullable: false,
    });
    await builder.alterField('issues', 'number', {
      type: 'integer',
      nullable: false,
    });
  },
});

export default migration;
