/**
 * The direct-write budget of a conversation run (NP-183, protocol-pm-assistant.md §3.3): the distinct objects its
 * direct writes touched, from `pmActWrites` (a comment or a dependency counts on its issue).
 */
import type { Conn } from '../shared/db.js';
import { str } from '../shared/db.js';

export interface WrittenObject {
  readonly objectType: string;
  readonly objectId: string;
}

export async function writtenObjects(
  conn: Conn,
  runId: string,
): Promise<WrittenObject[]> {
  const rows = await conn.query
    .selectFrom('pmActWrites')
    .select(['objectType', 'objectId'])
    .where('runId', '=', runId)
    .execute();
  const seen = new Map<string, WrittenObject>();
  for (const row of rows) {
    const objectType = str(row.objectType) ?? '';
    const objectId = str(row.objectId) ?? '';
    seen.set(`${objectType}:${objectId}`, { objectType, objectId });
  }
  return [...seen.values()];
}

export async function directWriteCount(
  conn: Conn,
  runId: string,
): Promise<number> {
  return (await writtenObjects(conn, runId)).length;
}
