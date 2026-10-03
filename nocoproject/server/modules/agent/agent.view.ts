/**
 * The browser's view of agents (`AgentView`): each row with its runtime's name and status, active run count, whether
 * the viewer may invoke and edit it, its owner's name, access list, delegation targets and skills. Split out of
 * `agent.service.ts` to keep it within the file size limit.
 */
import {
  canEditAgent,
  invokableAgentIds,
  type Viewer,
} from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { str, unique } from '../shared/db.js';
import { activeRunCounts } from '../run/run.queries.js';
import { isOnline } from '../runtime/runtime.records.js';
import { skillRefsForAgents } from '../skill/skill.service.js';
import type { AgentDeps, AgentRow, AgentView } from './agent.service.js';

export async function decorate(
  deps: AgentDeps,
  conn: Conn,
  viewer: Viewer,
  agents: readonly AgentRow[],
): Promise<AgentView[]> {
  const agentIds = agents.map((agent) => agent.id);
  const runtimeIds = unique(agents.map((agent) => agent.runtimeId));
  const runtimes = runtimeIds.length
    ? await conn.query
        .selectFrom('runtimes')
        .select(['id', 'name', 'status', 'lastSeenAt', 'runtimeType'])
        .where('id', 'in', runtimeIds)
        .execute()
    : [];
  const counts = await activeRunCounts(conn, 'agentId', agentIds);
  const owners = await deps.users.names(
    conn,
    agents.map((agent) => agent.ownerUserId),
  );
  const invokable = await invokableAgentIds(conn, viewer.userId, agents);
  const skills = await skillRefsForAgents(conn, agentIds);
  const grants = agentIds.length
    ? await conn.query
        .selectFrom('agentAccessGrants')
        .select(['agentId', 'userId'])
        .where('agentId', 'in', agentIds)
        .execute()
    : [];
  const delegations = agentIds.length
    ? await conn.query
        .selectFrom('agentDelegationGrants')
        .select(['agentId', 'targetAgentId'])
        .where('agentId', 'in', agentIds)
        .execute()
    : [];
  const targetNames = new Map<string, string>();
  const targetIds = unique(delegations.map((row) => str(row.targetAgentId)));
  if (targetIds.length > 0) {
    const rows = await conn.query
      .selectFrom('agents')
      .select(['id', 'name'])
      .where('id', 'in', targetIds)
      .execute();
    for (const row of rows)
      targetNames.set(str(row.id) ?? '', str(row.name) ?? '');
  }
  return agents.map((agent) => {
    const runtime = runtimes.find((row) => row.id === agent.runtimeId);
    return {
      ...agent,
      runtimeName: runtime ? str(runtime.name) : null,
      runtimeOnline: runtime
        ? isOnline(
            runtime.status,
            runtime.lastSeenAt,
            new Date(),
            runtime.runtimeType,
          )
        : false,
      activeRunCount: counts.get(agent.id) ?? 0,
      canInvoke: invokable.has(agent.id),
      canEdit: canEditAgent(viewer, agent),
      ownerName: owners.get(agent.ownerUserId) ?? null,
      accessUserIds: grants
        .filter((row) => row.agentId === agent.id)
        .map((row) => str(row.userId) ?? ''),
      delegationTargets: delegations
        .filter((row) => row.agentId === agent.id)
        .map((row) => {
          const id = str(row.targetAgentId) ?? '';
          return { id, name: targetNames.get(id) ?? id };
        }),
      skillIds: (skills.get(agent.id) ?? []).map((skill) => skill.id),
      skills: skills.get(agent.id) ?? [],
    };
  });
}
