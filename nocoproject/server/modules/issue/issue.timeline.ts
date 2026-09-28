/**
 * Paged activity stream of an issue (docs/phase1/iteration-3-contract.md §D): pages are newest-first slices returned
 * in ascending order, and `nextCursor` asks for the slice just before the oldest item of the page. The detail view
 * carries the first page (the latest 50) and `activitiesNextCursor`; comments are activities too
 * (`comment_added`, with `details.commentId`).
 */
import type { Conn } from '../shared/db.js';
import { fromJson, iso, str } from '../shared/db.js';
import { decodeCursor, encodeCursor } from '../shared/pagination.js';
import type { Activity, ActivityPage, ActorType } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { agentNames } from '../run/run.queries.js';

async function mapActivities(
  conn: Conn,
  users: UserDirectory,
  issueId: string,
  rows: readonly Record<string, unknown>[],
): Promise<Activity[]> {
  const userNames = await users.names(
    conn,
    rows
      .filter((row) => row.actorType === 'user')
      .map((row) => str(row.actorId)),
  );
  const agents = await agentNames(
    conn,
    rows
      .filter((row) => row.actorType === 'agent')
      .map((row) => str(row.actorId)),
  );
  return rows.map((row) => {
    const actorType = (str(row.actorType) ?? 'system') as ActorType;
    const actorId = str(row.actorId);
    const names = actorType === 'agent' ? agents : userNames;
    return {
      id: str(row.id) ?? '',
      issueId,
      actorType,
      actorId,
      actorName:
        actorType === 'system'
          ? 'system'
          : (names.get(actorId ?? '') ?? actorId ?? ''),
      action: str(row.action) ?? '',
      details: fromJson<Record<string, unknown>>(row.details),
      createdAt: iso(row.createdAt),
    };
  });
}

/** One page of the issue's activities (ascending), older than `cursor` when given. */
export async function activityPage(
  conn: Conn,
  users: UserDirectory,
  issueId: string,
  cursor: string | null,
  limit: number,
): Promise<ActivityPage> {
  let query = conn.query
    .selectFrom('activities')
    .selectAll()
    .where('issueId', '=', issueId);
  if (cursor) {
    const key = decodeCursor(cursor);
    query = query.where((eb) =>
      eb.or([
        eb('createdAt', '<', key.at),
        eb.and([eb('createdAt', '=', key.at), eb('id', '<', key.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit).reverse();
  const data = await mapActivities(conn, users, issueId, page);
  const oldest = data[0];
  return {
    data,
    nextCursor:
      rows.length > limit && oldest
        ? encodeCursor(oldest.createdAt, oldest.id)
        : null,
  };
}
