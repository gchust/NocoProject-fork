import {
  canInvokeAgent,
  loadAgentAccess,
  requireVisibleIssue,
  viewerOf,
} from '../shared/authz.js';
import type { Actor } from '../shared/activity.js';
import type { Conn } from '../shared/db.js';
import { fromJson } from '../shared/db.js';
import { NpError, invalid } from '../shared/errors.js';
import {
  AGENT_CAPABILITIES,
  type AgentCapability,
  type ConfigurationSnapshot,
} from '../shared/protocol.capabilities.js';
import { PM_CAPABILITIES } from '../shared/protocol.phase2-pm-assistant.js';
export function capabilitiesOf(value: unknown): AgentCapability[] {
  const values = fromJson<unknown>(value);
  return Array.isArray(values)
    ? values.filter((v): v is AgentCapability =>
        AGENT_CAPABILITIES.includes(v as AgentCapability),
      )
    : [];
}
/**
 * What an agent may do: its configured capabilities, except that a project manager type agent (`kind = 'manager'`)
 * always holds exactly `PM_CAPABILITIES` (NP-183, ADR-0009), whatever is stored.
 */
export function effectiveCapabilities(row: {
  readonly kind?: unknown;
  readonly capabilities?: unknown;
}): AgentCapability[] {
  return row.kind === 'manager'
    ? [...PM_CAPABILITIES]
    : capabilitiesOf(row.capabilities);
}
export function validateCapabilities(value: unknown): AgentCapability[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => !AGENT_CAPABILITIES.includes(v as AgentCapability))
  )
    throw invalid('INVALID_CAPABILITIES', 'Unknown capability.');
  return [...new Set(value)] as AgentCapability[];
}
export async function hasCapability(
  conn: Conn,
  agentId: string,
  capability: AgentCapability,
): Promise<boolean> {
  const row = await conn.query
    .selectFrom('agents')
    .select(['capabilities', 'archivedAt', 'kind'])
    .where('id', '=', agentId)
    .executeTakeFirst();
  return (
    !!row &&
    !row.archivedAt &&
    effectiveCapabilities(row).includes(capability)
  );
}
export async function requireCapability(
  conn: Conn,
  auth: {
    agentId: string;
    runId: string;
    actorUserId?: string | null;
    issueId?: string;
  },
  capability: AgentCapability,
): Promise<void> {
  const run = await conn.query
    .selectFrom('runs')
    .select([
      'agentId',
      'actorUserId',
      'subjectId',
      'status',
      'configurationSnapshot',
    ])
    .where('id', '=', auth.runId)
    .executeTakeFirst();
  const snapshot = fromJson<ConfigurationSnapshot>(run?.configurationSnapshot);
  const agent = await loadAgentAccess(conn, auth.agentId);
  const invokable =
    agent &&
    typeof run?.actorUserId === 'string' &&
    (await canInvokeAgent(conn, run.actorUserId, agent));
  // Missing snapshots (including pre-upgrade runs) fail closed.
  if (
    !invokable ||
    ('actorUserId' in auth && auth.actorUserId !== run?.actorUserId) ||
    ('issueId' in auth && auth.issueId !== run?.subjectId) ||
    !['dispatched', 'running'].includes(String(run?.status)) ||
    run?.agentId !== auth.agentId ||
    !snapshot?.capabilities?.includes(capability) ||
    !(await hasCapability(conn, auth.agentId, capability))
  ) {
    throw new NpError(
      'forbidden',
      'CAPABILITY_DENIED',
      `Capability required: ${capability}`,
      { capability },
    );
  }
  const viewer = await viewerOf(conn, {
    type: 'user',
    id: String(run.actorUserId),
  });
  await requireVisibleIssue(conn, viewer, String(run.subjectId));
}
export async function requireActorCapability(
  conn: Conn,
  actor: Actor,
  capability: AgentCapability,
  issueIdOrKey?: string,
): Promise<void> {
  if (actor.type !== 'agent') return;
  await requireCapability(
    conn,
    { agentId: actor.id ?? '', runId: actor.runId ?? '' },
    capability,
  );
  if (issueIdOrKey) {
    const run = await conn.query
      .selectFrom('runs')
      .select('subjectId')
      .where('id', '=', actor.runId ?? '')
      .executeTakeFirst();
    const issue = await conn.query
      .selectFrom('issues')
      .select(['id', 'identifier'])
      .where('id', '=', run?.subjectId ?? '')
      .executeTakeFirst();
    if (
      !issue ||
      (issue.id !== issueIdOrKey && issue.identifier !== issueIdOrKey)
    )
      throw new NpError(
        'forbidden',
        'ISSUE_NOT_IN_RUN',
        'A run may only write to its own issue.',
      );
  }
}
