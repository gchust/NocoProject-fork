/**
 * Pieces of the claim payload (`claim.service.ts`): the stage and signal extras of a trigger, the agent's delegation
 * targets and the trigger comments.
 */
import type { Conn } from '../shared/db.js';
import { fromJson, str, unique } from '../shared/db.js';
import type {
  ClaimedTriggerComment,
  ClaimedTriggerPhase2Extras,
  ClaimedTriggerSignalExtras,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { commentContextOf } from './claim.pm.js';

/** The `stage` of a `stageEntered` trigger, from its payload. */
export function stageOf(type: unknown, payload: unknown): ClaimedTriggerPhase2Extras {
  if (type !== 'stageEntered') return {};
  const value = fromJson<Record<string, unknown>>(payload) ?? {};
  return {
    stage: {
      from: str(value.from) ?? '',
      to: str(value.to) ?? '',
      instruction: str(value.instruction),
    },
  };
}

/** The `signal` of a `signal` trigger, from its payload. */
export function signalOf(type: unknown, payload: unknown): ClaimedTriggerSignalExtras {
  if (type !== 'signal') return {};
  const value = fromJson<Record<string, unknown>>(payload) ?? {};
  return {
    signal: {
      source: str(value.source) ?? '',
      kind: str(value.kind) ?? '',
      key: str(value.key) ?? '',
      title: str(value.title) ?? '',
      url: str(value.url),
      instruction: str(value.instruction),
    },
  };
}

export async function delegationTargets(
  conn: Conn,
  agentId: string,
): Promise<{ id: string; name: string }[]> {
  const grants = await conn.query
    .selectFrom('agentDelegationGrants')
    .select('targetAgentId')
    .where('agentId', '=', agentId)
    .execute();
  const ids = unique(grants.map((row) => str(row.targetAgentId)));
  if (ids.length === 0) return [];
  const rows = await conn.query
    .selectFrom('agents')
    .select(['id', 'name'])
    .where('id', 'in', ids)
    .orderBy('name', 'asc')
    .execute();
  return rows.map((row) => ({
    id: str(row.id) ?? '',
    name: str(row.name) ?? '',
  }));
}

export async function triggerComments(
  conn: Conn,
  users: UserDirectory,
  commentIds: string[],
): Promise<Map<string, ClaimedTriggerComment>> {
  const result = new Map<string, ClaimedTriggerComment>();
  if (commentIds.length === 0) return result;
  const rows = await conn.query
    .selectFrom('comments')
    .selectAll()
    .where('id', 'in', commentIds)
    .execute();
  const userNames = await users.names(
    conn,
    rows
      .filter((row) => row.authorType === 'user')
      .map((row) => str(row.authorId)),
  );
  const agentIds = unique(
    rows
      .filter((row) => row.authorType === 'agent')
      .map((row) => str(row.authorId)),
  );
  const agentRows = agentIds.length
    ? await conn.query
        .selectFrom('agents')
        .select(['id', 'name'])
        .where('id', 'in', agentIds)
        .execute()
    : [];
  const agentNames = new Map(
    agentRows.map((row) => [str(row.id) ?? '', str(row.name) ?? '']),
  );
  for (const row of rows) {
    const id = str(row.id) ?? '';
    const authorId = str(row.authorId) ?? '';
    const authorName =
      row.authorType === 'agent'
        ? agentNames.get(authorId)
        : row.authorType === 'user'
          ? userNames.get(authorId)
          : 'system';
    result.set(id, {
      id,
      authorName: authorName ?? authorId,
      content: str(row.content) ?? '',
      parentId: str(row.parentId),
      rootId: str(row.rootId) ?? id,
      ...commentContextOf(row),
    });
  }
  return result;
}

