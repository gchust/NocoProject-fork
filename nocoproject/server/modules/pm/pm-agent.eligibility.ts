/**
 * Which agent runs a member's project manager conversations (NP-183, protocol-pm-assistant.md §5.6, §6):
 *
 * - The system default is `agentEntries.conversation.agentId` while the entry is enabled; it must be a project manager
 *   type agent (`kind = 'manager'`), not archived, which the member may invoke.
 * - A personal project manager is one of the member's own agents and must pass every rule of §6.3, else 400
 *   `PM_AGENT_NOT_ELIGIBLE` with the first failing `reason`. The rules live only here: choosing, copying, editing the
 *   agent and re-checking a conversation's binding all call `personalIneligibility`.
 */
import { canInvokeAgent, loadAgentAccess } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { str } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  PmAgentIneligibleReason,
  PmAgentSource,
  PmConversationAgent,
} from '../shared/protocol.js';
import type { SettingsService } from '../system/settings.service.js';
import { pmCompatOf } from '../runtime/daemon-compat.js';

export interface PmAgentFacts {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly provider: string;
  readonly model: string | null;
  readonly ownerUserId: string | null;
  readonly access: string;
  readonly archived: boolean;
  readonly runtime: {
    readonly id: string;
    readonly name: string;
    readonly ownerUserId: string | null;
    readonly visibility: string;
    readonly pmAllowed: boolean;
    readonly online: boolean;
    readonly compat: 'ok' | 'deprecated' | 'upgrade_required';
  } | null;
}

export async function loadPmAgentFacts(
  conn: Conn,
  agentId: string | null | undefined,
): Promise<PmAgentFacts | null> {
  if (!agentId) return null;
  const agent = await conn.query
    .selectFrom('agents')
    .selectAll()
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (!agent || agent.deletedAt) return null;
  const runtime = agent.runtimeId
    ? await conn.query
        .selectFrom('runtimes')
        .selectAll()
        .where('id', '=', String(agent.runtimeId))
        .executeTakeFirst()
    : undefined;
  return {
    id: agentId,
    name: str(agent.name) ?? '',
    kind: str(agent.kind) ?? 'coder',
    provider: str(agent.provider) ?? '',
    model: str(agent.model),
    ownerUserId: str(agent.ownerUserId),
    access: str(agent.access) ?? 'ownerOnly',
    archived: !!agent.archivedAt,
    runtime: runtime
      ? {
          id: String(runtime.id),
          name: str(runtime.name) ?? '',
          ownerUserId: str(runtime.ownerUserId),
          visibility: str(runtime.visibility) ?? 'private',
          pmAllowed: !!runtime.pmAllowed,
          online: runtime.status === 'online',
          compat: pmCompatOf(runtime),
        }
      : null,
  };
}

/** Whether a runtime may run `userId`'s personal project manager: their own, or a public one marked `pmAllowed`. */
export function runtimeFitsPersonal(
  runtime: PmAgentFacts['runtime'],
  userId: string,
): boolean {
  return (
    !!runtime &&
    (runtime.ownerUserId === userId ||
      (runtime.visibility === 'public' && runtime.pmAllowed))
  );
}

/** The first §6.3 rule `agent` fails as `userId`'s personal project manager, or null. */
export function personalIneligibility(
  agent: PmAgentFacts | null,
  userId: string,
  allowPersonal: boolean,
): PmAgentIneligibleReason | null {
  if (!allowPersonal) return 'personalDisabled';
  if (!agent || agent.kind !== 'manager') return 'notManager';
  if (agent.archived) return 'archived';
  if (agent.ownerUserId !== userId) return 'notOwner';
  if (agent.access !== 'ownerOnly') return 'notPrivate';
  if (!runtimeFitsPersonal(agent.runtime, userId)) return 'foreignRuntime';
  return null;
}

export function notEligible(reason: PmAgentIneligibleReason): never {
  throw invalid(
    'PM_AGENT_NOT_ELIGIBLE',
    `This agent cannot be your project manager (${reason}).`,
    { reason },
  );
}

export async function allowsPersonal(
  conn: Conn,
  settings: SettingsService,
): Promise<boolean> {
  return (await settings.read(conn)).agentEntries.conversation.allowPersonal === true;
}

/** The system default project manager `userId` may use, or null. */
export async function systemPmAgent(
  conn: Conn,
  settings: SettingsService,
  userId: string,
): Promise<PmAgentFacts | null> {
  const { conversation } = (await settings.read(conn)).agentEntries;
  if (!conversation.enabled) return null;
  const facts = await loadPmAgentFacts(conn, conversation.agentId);
  if (!facts || facts.archived || facts.kind !== 'manager') return null;
  return (await canUse(conn, userId, facts.id)) ? facts : null;
}

async function canUse(conn: Conn, userId: string, agentId: string) {
  const target = await loadAgentAccess(conn, agentId);
  return !!target && (await canInvokeAgent(conn, userId, target));
}

/** Whether a conversation may keep its bound agent (§5.6): still a usable manager, and for a personal one §6.3. */
export async function boundAgentUsable(
  conn: Conn,
  settings: SettingsService,
  userId: string,
  agentId: string | null,
  source: PmAgentSource,
): Promise<boolean> {
  const facts = await loadPmAgentFacts(conn, agentId);
  if (!facts || facts.archived || facts.kind !== 'manager') return false;
  if (!(await canUse(conn, userId, facts.id))) return false;
  if (source !== 'personal') return true;
  return (
    personalIneligibility(facts, userId, await allowsPersonal(conn, settings)) ===
    null
  );
}

/** The conversation header's view of its agent. */
export async function conversationAgentView(
  conn: Conn,
  settings: SettingsService,
  row: {
    readonly ownerUserId: string;
    readonly agentId: string | null;
    readonly agentSource: PmAgentSource;
    readonly personalAgentId: string | null;
  },
): Promise<PmConversationAgent | null> {
  const facts = await loadPmAgentFacts(conn, row.agentId);
  if (!facts) return null;
  const personalAvailable =
    row.agentSource === 'fallback' && !!row.personalAgentId
      ? personalIneligibility(
          await loadPmAgentFacts(conn, row.personalAgentId),
          row.ownerUserId,
          await allowsPersonal(conn, settings),
        ) === null
      : false;
  return {
    id: facts.id,
    name: facts.name,
    source: row.agentSource,
    online: facts.runtime?.online ?? false,
    runtimeName: facts.runtime?.name ?? null,
    compat: facts.runtime?.compat ?? 'upgrade_required',
    personalAvailable,
  };
}
