/**
 * The executor roster the project manager picks executors from (NP-183, protocol-pm-assistant.md §7.2):
 * `GET /np/agent/pm/agents` → `PmRosterAgent[]`. Every live agent, except project manager type agents the asker may
 * not invoke (other members' personal project managers). No environment variables, machine paths, credentials or
 * access lists. Load and 30-day statistics come from one aggregate query each.
 */
import { canInvokeAgent, loadAgentAccess } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { num, str, unique } from '../shared/db.js';
import {
  PM_ROSTER_SUMMARY_FALLBACK,
  type PmRosterAgent,
} from '../shared/protocol.js';
import { effectiveCapabilities } from '../agent/capabilities.js';
import { agentKindOf, reasoningEffortOf } from '../agent/agent.fields.js';
import { pmCompatOf } from '../runtime/daemon-compat.js';

const STATS_DAYS = 30;
const DONE_STATUSES = ['done'];

async function countsBy(
  conn: Conn,
  statuses: readonly string[] | null,
  since?: Date,
): Promise<Map<string, number>> {
  let query = conn.query
    .selectFrom('runs')
    .select((eb) => ['agentId', eb.fn.countAll().as('count')]);
  if (statuses) query = query.where('status', 'in', [...statuses]);
  if (since) query = query.where('createdAt', '>=', since);
  const rows = await query.groupBy('agentId').execute();
  return new Map(rows.map((row) => [str(row.agentId) ?? '', num(row.count)]));
}

async function doneIssues(
  conn: Conn,
  since: Date,
): Promise<Map<string, number>> {
  const rows = await conn.query
    .selectFrom('issues')
    .select((eb) => ['executorId', eb.fn.countAll().as('count')])
    .where('executorType', '=', 'agent')
    .where('statusKey', 'in', DONE_STATUSES)
    .where('updatedAt', '>=', since)
    .where('deletedAt', 'is', null)
    .groupBy('executorId')
    .execute();
  return new Map(
    rows.map((row) => [str(row.executorId) ?? '', num(row.count)]),
  );
}

async function skillsOf(
  conn: Conn,
  agentIds: readonly string[],
): Promise<Map<string, { name: string; description: string }[]>> {
  const result = new Map<string, { name: string; description: string }[]>();
  if (agentIds.length === 0) return result;
  const rows = await conn.query
    .selectFrom('agentSkills')
    .innerJoin('skills', 'skills.id', 'agentSkills.skillId')
    .select([
      'agentSkills.agentId as agentId',
      'skills.name as name',
      'skills.description as description',
    ])
    .where('agentSkills.agentId', 'in', [...agentIds])
    .orderBy('skills.name', 'asc')
    .execute();
  for (const row of rows) {
    const id = str(row.agentId) ?? '';
    result.set(id, [
      ...(result.get(id) ?? []),
      { name: str(row.name) ?? '', description: str(row.description) ?? '' },
    ]);
  }
  return result;
}

async function delegationOf(
  conn: Conn,
  agentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (agentIds.length === 0) return result;
  const rows = await conn.query
    .selectFrom('agentDelegationGrants')
    .select(['agentId', 'targetAgentId'])
    .where('agentId', 'in', [...agentIds])
    .execute();
  for (const row of rows) {
    const id = str(row.agentId) ?? '';
    result.set(id, [...(result.get(id) ?? []), str(row.targetAgentId) ?? '']);
  }
  return result;
}

function summaryOf(row: Record<string, unknown>): string {
  const own = str(row.summary)?.trim();
  if (own) return own;
  return [...(str(row.instructions) ?? '')]
    .slice(0, PM_ROSTER_SUMMARY_FALLBACK)
    .join('');
}

export async function roster(
  conn: Conn,
  askerId: string,
): Promise<PmRosterAgent[]> {
  const agents = await conn.query
    .selectFrom('agents')
    .selectAll()
    .where('archivedAt', 'is', null)
    .where('deletedAt', 'is', null)
    .orderBy('name', 'asc')
    .execute();
  const ids = agents.map((row) => str(row.id) ?? '');
  const runtimeIds = unique(agents.map((row) => str(row.runtimeId)));
  const runtimes = runtimeIds.length
    ? await conn.query
        .selectFrom('runtimes')
        .selectAll()
        .where('id', 'in', runtimeIds)
        .execute()
    : [];
  const since = new Date(Date.now() - STATS_DAYS * 86_400_000);
  const [running, queued, runs, failed, done, skills, delegation] =
    await Promise.all([
      countsBy(conn, ['dispatched', 'running']),
      countsBy(conn, ['queued', 'deferred']),
      countsBy(conn, null, since),
      countsBy(conn, ['failed'], since),
      doneIssues(conn, since),
      skillsOf(conn, ids),
      delegationOf(conn, ids),
    ]);
  const result: PmRosterAgent[] = [];
  for (const row of agents) {
    const id = str(row.id) ?? '';
    const target = await loadAgentAccess(conn, id);
    const canInvoke = !!target && (await canInvokeAgent(conn, askerId, target));
    const kind = agentKindOf(row.kind);
    if (kind === 'manager' && !canInvoke) continue;
    const runtime = runtimes.find((item) => item.id === row.runtimeId);
    result.push({
      id,
      name: str(row.name) ?? '',
      kind,
      provider: str(row.provider) ?? '',
      model: str(row.model),
      reasoningEffort: reasoningEffortOf(row.reasoningEffort),
      summary: summaryOf(row),
      skills: skills.get(id) ?? [],
      capabilities: effectiveCapabilities(row),
      runtime: runtime
        ? {
            id: str(runtime.id) ?? '',
            name: str(runtime.name) ?? '',
            online: runtime.status === 'online',
            lastHeartbeatAt: runtime.lastSeenAt
              ? new Date(String(runtime.lastSeenAt)).toISOString()
              : null,
            compat:
              kind === 'manager'
                ? pmCompatOf(runtime)
                : runtime.status === 'upgrade_required'
                  ? 'upgrade_required'
                  : 'ok',
          }
        : null,
      load: {
        running: running.get(id) ?? 0,
        queued: queued.get(id) ?? 0,
        maxConcurrentRuns: num(row.maxConcurrentRuns, 1),
      },
      stats30d: {
        runs: runs.get(id) ?? 0,
        failed: failed.get(id) ?? 0,
        doneIssues: done.get(id) ?? 0,
      },
      canInvoke,
      delegation: delegation.get(id) ?? [],
    });
  }
  return result;
}
