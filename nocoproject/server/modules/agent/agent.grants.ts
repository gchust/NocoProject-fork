/**
 * An agent's access list (`agentAccessGrants`, whole-set replace) and delegation list (`agentDelegationGrants`: agents
 * it may hand sub-issues to without a proposal). Adding a delegation target requires access to it; keeping one does
 * not. NP-219: a delegation target executes sub-issues, so it is never a built-in agent (`EXECUTOR_RUNTIME_TYPE`).
 * Split out of `agent.service.ts` to keep it within the file size limit.
 */
import {
  canInvokeAgent,
  forbid,
  loadAgentAccess,
  type Viewer,
} from '../shared/authz.js';
import type { Tx } from '../shared/db.js';
import { now, str } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type { UserDirectory } from '../shared/users.js';
import { requireExecutorRuntimeType } from './agent.runtime-type.js';

export async function replaceAccessList(
  tx: Tx,
  ids: IdSource,
  users: UserDirectory,
  agentId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of userIds)
    if (!(await users.exists(tx.conn, userId)))
      throw invalid('INVALID_USER', `accessUserIds: ${userId} does not exist.`);
  await tx.conn.query
    .deleteFrom('agentAccessGrants')
    .where('agentId', '=', agentId)
    .execute();
  if (userIds.length === 0) return;
  const createdAt = now();
  await tx.conn.query
    .insertInto('agentAccessGrants')
    .values(
      userIds.map((userId) => ({ id: ids.next(), agentId, userId, createdAt })),
    )
    .execute();
}

export async function replaceDelegation(
  tx: Tx,
  ids: IdSource,
  viewer: Viewer,
  agentId: string,
  targetIds: readonly string[],
): Promise<void> {
  const current = new Set(
    (
      await tx.conn.query
        .selectFrom('agentDelegationGrants')
        .select('targetAgentId')
        .where('agentId', '=', agentId)
        .execute()
    ).map((row) => str(row.targetAgentId)),
  );
  for (const targetId of targetIds) {
    if (targetId === agentId)
      throw invalid(
        'INVALID_DELEGATION',
        'An agent cannot delegate to itself.',
      );
    const target = await loadAgentAccess(tx.conn, targetId);
    if (!target)
      throw invalid('INVALID_DELEGATION', `Agent ${targetId} does not exist.`);
    // NP-219: a delegation target executes sub-issues, which a built-in agent never does.
    await requireExecutorRuntimeType(tx.conn, targetId);
    // Keeping an existing target needs no fresh check; adding one needs access to it.
    if (
      !current.has(targetId) &&
      !(await canInvokeAgent(tx.conn, viewer.userId, target))
    )
      forbid(`You do not have access to agent ${targetId}.`);
  }
  await tx.conn.query
    .deleteFrom('agentDelegationGrants')
    .where('agentId', '=', agentId)
    .execute();
  if (targetIds.length === 0) return;
  const createdAt = now();
  await tx.conn.query
    .insertInto('agentDelegationGrants')
    .values(
      targetIds.map((targetAgentId) => ({
        id: ids.next(),
        agentId,
        targetAgentId,
        grantedById: viewer.userId,
        createdAt,
      })),
    )
    .execute();
}
