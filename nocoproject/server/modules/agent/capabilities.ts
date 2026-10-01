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
import { BUILTIN_UNSUPPORTED_CAPABILITIES } from '../shared/protocol.runtime-types.js';

const BUILTIN_UNSUPPORTED: readonly AgentCapability[] =
  BUILTIN_UNSUPPORTED_CAPABILITIES;

/** NP-219 (protocol-runtime-types.md §3.2): a built-in project manager's fixed set, without `repo.read`. */
export const BUILTIN_PM_CAPABILITIES: readonly AgentCapability[] =
  PM_CAPABILITIES.filter((key) => !BUILTIN_UNSUPPORTED.includes(key));

/** The capabilities of `values` a built-in agent may not hold. */
export function unsupportedForBuiltin(
  values: readonly AgentCapability[],
): AgentCapability[] {
  return values.filter((key) => BUILTIN_UNSUPPORTED.includes(key));
}

/** 400 `CAPABILITY_NOT_FOR_RUNTIME_TYPE` when a built-in agent asks for one of §3.2's capabilities. */
export function requireRuntimeTypeCapabilities(
  runtimeType: unknown,
  values: readonly AgentCapability[],
): void {
  if (runtimeType !== 'builtin') return;
  const capabilities = unsupportedForBuiltin(values);
  if (capabilities.length > 0)
    throw invalid(
      'CAPABILITY_NOT_FOR_RUNTIME_TYPE',
      'A built-in agent cannot access repositories, terminals or local files.',
      { capabilities },
    );
}
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
 * always holds exactly `PM_CAPABILITIES` (NP-183, ADR-0009), whatever is stored. NP-219: a built-in agent never holds
 * §3.2's capabilities (its project manager set is `BUILTIN_PM_CAPABILITIES`); writes already refuse them, this is
 * the backstop.
 */
export function effectiveCapabilities(row: {
  readonly kind?: unknown;
  readonly capabilities?: unknown;
  readonly runtimeType?: unknown;
}): AgentCapability[] {
  const builtin = row.runtimeType === 'builtin';
  if (row.kind === 'manager')
    return builtin ? [...BUILTIN_PM_CAPABILITIES] : [...PM_CAPABILITIES];
  const stored = capabilitiesOf(row.capabilities);
  return builtin
    ? stored.filter((key) => !BUILTIN_UNSUPPORTED.includes(key))
    : stored;
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
    .select(['capabilities', 'archivedAt', 'kind', 'runtimeType'])
    .where('id', '=', agentId)
    .executeTakeFirst();
  return (
    !!row && !row.archivedAt && effectiveCapabilities(row).includes(capability)
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
