/**
 * Agent rules the project manager assistant adds (NP-183, protocol-pm-assistant.md §2.2, §6.3, §7.2):
 *
 * - `summary` ("what it is good at", at most 200 characters; 400 `INVALID_SUMMARY`);
 * - a project manager type agent's capabilities are fixed to `PM_CAPABILITIES`: a PATCH that asks for anything else
 *   is 400 `MANAGER_CAPABILITIES_FIXED` (sending the fixed set back, as the form does, is fine);
 * - an agent some member chose as their personal project manager stays `ownerOnly` (400
 *   `PERSONAL_PM_MUST_BE_PRIVATE`) and on a runtime §6.3 allows (400 `PM_AGENT_NOT_ELIGIBLE`, `foreignRuntime`).
 */
import type { Conn } from '../shared/db.js';
import { str } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import { AGENT_SUMMARY_MAX } from '../shared/protocol.phase2-pm-assistant.js';
import { effectiveCapabilities } from './capabilities.js';
import { runtimeFitsPersonal } from '../pm/pm-agent.eligibility.js';

export function validateSummary(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || [...value].length > AGENT_SUMMARY_MAX)
    throw invalid(
      'INVALID_SUMMARY',
      `summary must be text of at most ${AGENT_SUMMARY_MAX} characters.`,
    );
  return value.trim() || null;
}

/** NP-219: compared with the agent's effective set, so a built-in project manager sends `BUILTIN_PM_CAPABILITIES`. */
export function requireFixedManagerCapabilities(
  kind: string,
  capabilities: readonly string[] | undefined,
  runtimeType: string = 'computer',
): void {
  if (kind !== 'manager' || capabilities === undefined) return;
  const fixed = effectiveCapabilities({ kind, runtimeType });
  const same =
    capabilities.length === fixed.length &&
    fixed.every((key) => capabilities.includes(key));
  if (!same)
    throw invalid(
      'MANAGER_CAPABILITIES_FIXED',
      'A project manager type agent always holds the project manager capabilities.',
    );
}

/** The members who chose `agentId` as their personal project manager. */
async function choosers(conn: Conn, agentId: string): Promise<string[]> {
  const rows = await conn.query
    .selectFrom('members')
    .select('userId')
    .where('pmAgentMode', '=', 'personal')
    .where('pmAgentId', '=', agentId)
    .execute();
  return rows.map((row) => str(row.userId) ?? '');
}

export async function requirePersonalPmStaysEligible(
  conn: Conn,
  agentId: string,
  values: { readonly access?: unknown; readonly runtimeId?: unknown },
): Promise<void> {
  const chosenBy = await choosers(conn, agentId);
  if (chosenBy.length === 0) return;
  if (values.access !== undefined && values.access !== 'ownerOnly')
    throw invalid(
      'PERSONAL_PM_MUST_BE_PRIVATE',
      'This agent is a personal project manager; it must stay visible to its owner only.',
    );
  if (typeof values.runtimeId !== 'string') return;
  const runtime = await conn.query
    .selectFrom('runtimes')
    .select(['ownerUserId', 'visibility', 'pmAllowed', 'runtimeType'])
    .where('id', '=', values.runtimeId)
    .executeTakeFirst();
  const fits = (userId: string) =>
    runtimeFitsPersonal(
      runtime
        ? {
            ownerUserId: str(runtime.ownerUserId),
            visibility: str(runtime.visibility) ?? 'private',
            pmAllowed: !!runtime.pmAllowed,
            runtimeType: str(runtime.runtimeType) ?? 'computer',
          }
        : null,
      userId,
    );
  if (!chosenBy.every(fits))
    throw invalid(
      'PM_AGENT_NOT_ELIGIBLE',
      'A personal project manager runs on its owner’s computer or a shared runtime allowed for project managers.',
      { reason: 'foreignRuntime' },
    );
}
