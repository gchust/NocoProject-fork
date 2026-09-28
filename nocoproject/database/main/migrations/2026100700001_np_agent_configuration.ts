import { defineMigration } from '@nocobase/db';
// Historical backfill only. Runtime code never derives permissions from kind.
const read = [
  'context.read',
  'workspace.read',
  'comment.create',
  'knowledge.propose',
];
const coding = [
  'context.read',
  'comment.create',
  'knowledge.propose',
  'issue.execute',
  'subtask.create',
  'dependency.write',
  'issue.status.write',
  'design.propose',
  'checklist.write',
  'workflow.propose',
  'pullRequest.link',
];
export default defineMigration({
  name: '2026100700001_np_agent_configuration',
  irreversible: true,
  async up({ builder, query }) {
    await builder.alterCollection('agents', (t) => {
      t.json('capabilities').nullable();
      t.integer('configurationRevision').notNull().defaultTo(1);
    });
    await builder.alterCollection('runs', (t) => {
      t.json('configurationSnapshot').nullable();
    });
    await builder.alterCollection('runSessions', (t) => {
      t.integer('configurationRevision').nullable();
      t.integer('entryRevision').nullable();
      t.string('configurationFingerprint', { length: 64 }).nullable();
    });
    await builder.createCollection('agentConfigurationChanges', (t) => {
      t.string('id', { length: 64 }).primary();
      t.string('agentId', { length: 64 }).notNull();
      t.string('actorUserId', { length: 64 }).notNull();
      t.integer('revision').notNull();
      t.json('before').nullable();
      t.json('after').notNull();
      t.datetimeTz('createdAt').notNull();
    });
    const agents = await query
      .selectFrom('agents')
      .select(['id', 'kind'])
      .execute();
    for (const agent of agents)
      await query
        .updateTable('agents')
        .set({
          capabilities: JSON.stringify(
            agent.kind === 'manager' ? read : coding,
          ),
        })
        .where('id', '=', agent.id)
        .execute();
    const active = await query
      .selectFrom('runs')
      .select(['id', 'agentId'])
      .where('status', 'in', ['dispatched', 'running'])
      .execute();
    for (const run of active) {
      const agent = agents.find((a) => a.id === run.agentId);
      await query
        .updateTable('runs')
        .set({
          configurationSnapshot: JSON.stringify({
            configurationRevision: 0,
            capabilities: agent
              ? agent.kind === 'manager'
                ? read
                : coding
              : [],
            instructions: '[pre-upgrade run: instructions not captured]',
            taskInstructions: '',
            skillIds: [],
            entryRevision: 0,
          }),
        })
        .where('id', '=', run.id)
        .execute();
    }
    const rows = await query.selectFrom('systemSettings').selectAll().execute();
    for (const row of rows) {
      const settings = (
        typeof row.settings === 'string'
          ? JSON.parse(row.settings)
          : row.settings
      ) as Record<string, unknown> | null;
      if (!settings || settings.agentEntries) continue;
      settings.agentEntries = {
        revision: 1,
        conversation: {
          agentId:
            typeof settings.pmAgentId === 'string' ? settings.pmAgentId : null,
          name: '项目经理',
          instructions: '',
          enabled: true,
        },
        completion: {
          agentId:
            typeof settings.pmAgentId === 'string' ? settings.pmAgentId : null,
          name: '任务完成',
          enabled: settings.retrospectiveOnDone !== false,
          instructions:
            '任务已完成。请阅读任务、评论、活动和关联 PR，追加一条以 /note 开头的内部总结，说明完成内容、运行成本及值得保留的经验；有需要时提出知识建议。不要修改任务状态。',
        },
      };
      await query
        .updateTable('systemSettings')
        .set({ settings: JSON.stringify(settings) })
        .where('id', '=', row.id)
        .execute();
    }
  },
});
