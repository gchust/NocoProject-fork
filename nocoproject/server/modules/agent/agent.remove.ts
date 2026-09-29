import type { Actor } from '../shared/activity.js';
import { forbid, viewerOf } from '../shared/authz.js';
import { now, num, str } from '../shared/db.js';
import { conflict, notFound } from '../shared/errors.js';
import { ACTIVE_STATUSES } from '../run/run.records.js';
import type { AgentDeps } from './agent.service.js';

/** Delete the configuration, retaining the identity used by historical comments, runs and audits. */
export async function removeAgent(
  deps: AgentDeps,
  actor: Actor,
  id: string,
): Promise<void> {
  await deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    const agent = await tx.conn.query
      .selectFrom('agents')
      .select(['id', 'ownerUserId'])
      .where('id', '=', id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!agent) throw notFound('Agent');
    if (agent.ownerUserId !== viewer.userId)
      forbid('Only the agent owner may delete this agent.');
    const active = await tx.conn.query
      .selectFrom('runs')
      .select('id')
      .where('agentId', '=', id)
      .where('status', 'in', ACTIVE_STATUSES)
      .executeTakeFirst();
    if (active)
      throw conflict(
        'AGENT_HAS_ACTIVE_RUNS',
        'Finish or cancel active runs before deleting this agent.',
      );

    const timestamp = now();
    // Existing invocation and claim paths already reject archived agents. The separate
    // tombstone prevents unarchiving from restoring a deleted configuration.
    await tx.conn.query
      .updateTable('agents')
      .set({
        deletedAt: timestamp,
        archivedAt: timestamp,
        runtimeId: null,
        instructions: '',
        updatedAt: timestamp,
      })
      .where('id', '=', id)
      .execute();

    const issues = await tx.conn.query
      .selectFrom('issues')
      .select(['id', 'revision'])
      .where('executorType', '=', 'agent')
      .where('executorId', '=', id)
      .execute();
    for (const issue of issues) {
      const issueId = str(issue.id) ?? '';
      const changed = await tx.conn.query
        .updateTable('issues')
        .set({
          executorType: 'none',
          executorId: null,
          revision: num(issue.revision, 1) + 1,
          updatedAt: timestamp,
        })
        .where('id', '=', issueId)
        .where('revision', '=', issue.revision)
        .where('executorType', '=', 'agent')
        .where('executorId', '=', id)
        .execute();
      if (!changed.updatedCount)
        throw conflict(
          'REVISION_CONFLICT',
          'An assigned issue changed. Retry deleting the agent.',
        );
      await deps.activity.record(tx.conn, {
        issueId,
        actor,
        action: 'executor_changed',
        details: {
          from: { type: 'agent', id },
          to: { type: 'none', id: null },
          reason: 'agentDeleted',
        },
      });
      tx.emit({ type: 'issue.changed', issueId });
    }
    for (const table of [
      'agentAccessGrants',
      'agentSkills',
      'agentEnvVars',
      'runSessions',
    ]) {
      await tx.conn.query.deleteFrom(table).where('agentId', '=', id).execute();
    }
    await tx.conn.query
      .deleteFrom('agentDelegationGrants')
      .where((eb) =>
        eb.or([eb('agentId', '=', id), eb('targetAgentId', '=', id)]),
      )
      .execute();
    tx.emit({ type: 'agents.changed' });
  });
}
