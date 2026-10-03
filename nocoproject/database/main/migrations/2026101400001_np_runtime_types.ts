// NocoProject: runtime types, computer agents and built-in agents (NP-219; docs/phase2/protocol-runtime-types.md §2).
//
// - agents.runtimeType: 'computer' | 'builtin', set when the agent is created and never changed.
// - runtimes.runtimeType, plus for built-in runtimes `llmService` (the AI plugin's LLM service name), `statusReason`
//   (why it is offline) and `lastCheckedAt` (the last connectivity check). A built-in runtime keeps the existing
//   NOT NULL `daemonId` and the unique (daemonId, provider) pair with a synthetic `builtin:<llmService>`.
// - runs.runtimeType: the agent's type when the run was enqueued, indexed with `status` for filters and claims.
//
// Every existing row is a computer one, so the column defaults are the whole backfill.
//
// `down` drops what `up` added; it refuses while a built-in runtime or agent exists (fix forward instead).
//
// Self-contained on purpose: every field is spelled out here and nothing is imported from server/modules, so the
// meaning of this migration never changes after it has run.
import { defineMigration, type MigrationDefinition } from '@nocobase/db';

const TYPE = { length: 16 } as const;

const migration: MigrationDefinition = defineMigration({
  name: '2026101400001_np_runtime_types',

  async up({ builder }) {
    await builder.alterCollection('agents', (table) => {
      table.string('runtimeType', TYPE).notNull().defaultTo('computer');
    });
    await builder.alterCollection('runtimes', (table) => {
      table.string('runtimeType', TYPE).notNull().defaultTo('computer');
      table.string('llmService', { length: 128 }).nullable();
      table.string('statusReason', { length: 32 }).nullable();
      table.datetimeTz('lastCheckedAt').nullable();
    });
    await builder.alterCollection('runs', (table) => {
      table.string('runtimeType', TYPE).notNull().defaultTo('computer');
      table.index(['runtimeType', 'status'], {
        name: 'np_runs_runtime_type_status_idx',
      });
    });
  },

  async down({ builder, query }) {
    const runtime = await query
      .selectFrom('runtimes')
      .select('id')
      .where('runtimeType', '=', 'builtin')
      .limit(1)
      .executeTakeFirst();
    const agent = await query
      .selectFrom('agents')
      .select('id')
      .where('runtimeType', '=', 'builtin')
      .limit(1)
      .executeTakeFirst();
    if (runtime || agent)
      throw new Error(
        'Built-in runtimes or agents exist; fix forward instead of rolling back.',
      );
    // Two steps: within one alteration the column would go first, taking the index with it.
    await builder.alterCollection('runs', (table) => {
      table.dropIndex('np_runs_runtime_type_status_idx');
    });
    await builder.alterCollection('runs', (table) => {
      table.dropFields('runtimeType');
    });
    await builder.alterCollection('runtimes', (table) => {
      table.dropFields(
        'runtimeType',
        'llmService',
        'statusReason',
        'lastCheckedAt',
      );
    });
    await builder.alterCollection('agents', (table) => {
      table.dropFields('runtimeType');
    });
  },
});

export default migration;
