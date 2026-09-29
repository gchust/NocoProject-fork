/**
 * The signed-in member's inbox and issue subscriptions (docs/phase1/iteration-1-contract.md §E).
 *
 * The list is newest first (`updatedAt`, then id) and pages with an opaque cursor. Unread counts cover items that
 * are unread, not archived and not resolved; the pending count covers decisions that are not archived and not
 * resolved, read or not (what the navigation badge shows: opening a decision does not settle it).
 */
import type { Actor } from '../shared/activity.js';
import { requireVisibleIssue, viewerOf } from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { now, num, toDate } from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  InboxItemV4,
  InboxKind,
  InboxListResponse,
  InboxPendingCounts,
  InboxUnreadCounts,
} from '../shared/protocol.js';

/** `InboxListResponse` whose items may carry the iteration 2 types. */
export type InboxListResponseV2 = Omit<InboxListResponse, 'data'> & {
  readonly data: readonly InboxItemV4[];
};
import { mapInboxItems, subscribe, unsubscribe } from './inbox.store.js';

const PAGE_SIZE = 50;

export interface InboxQuery {
  readonly kind?: string | null;
  readonly archived?: string | null;
  readonly resolved?: string | null;
  /** Only the items about one issue (nocosolution/frontend/frontend-standard.md §S3: the issue page's "Waiting for you" section, np.decision.section.title). */
  readonly issueId?: string | null;
  readonly cursor?: string | null;
}

export type InboxAction = 'read' | 'unread' | 'archive' | 'unarchive';

export interface InboxService {
  list(actor: Actor, query: InboxQuery): Promise<InboxListResponseV2>;
  unreadCount(actor: Actor): Promise<InboxUnreadCounts>;
  pendingCount(actor: Actor): Promise<InboxPendingCounts>;
  mark(actor: Actor, itemId: string, action: InboxAction): Promise<InboxItemV4>;
  readAll(actor: Actor, kind: unknown): Promise<InboxUnreadCounts>;
  subscribe(actor: Actor, issueIdOrKey: string): Promise<void>;
  unsubscribe(actor: Actor, issueIdOrKey: string): Promise<void>;
}

function parseKind(value: unknown): InboxKind | null {
  if (value === undefined || value === null || value === '') return null;
  if (value !== 'decision' && value !== 'info')
    throw invalid('INVALID_KIND', 'kind must be decision or info.');
  return value;
}

function parseFlag(
  value: string | null | undefined,
  name: string,
): boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw invalid('INVALID_QUERY', `${name} must be true or false.`);
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt, id])).toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  try {
    const [updatedAt, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [string, string];
    const date = toDate(updatedAt);
    if (!date || typeof id !== 'string') throw new Error('bad cursor');
    return { updatedAt: date, id };
  } catch {
    throw invalid('INVALID_CURSOR', 'cursor is not valid.');
  }
}

async function unread(conn: Conn, userId: string): Promise<InboxUnreadCounts> {
  const rows = await conn.query
    .selectFrom('inboxItems')
    .select((eb) => ['kind', eb.fn.countAll().as('count')])
    .where('userId', '=', userId)
    .where('readAt', 'is', null)
    .where('archivedAt', 'is', null)
    .where('resolvedAt', 'is', null)
    .groupBy('kind')
    .execute();
  const counts = { decision: 0, info: 0 };
  for (const row of rows) {
    if (row.kind === 'decision') counts.decision = num(row.count);
    else if (row.kind === 'info') counts.info = num(row.count);
  }
  return counts;
}

async function pending(
  conn: Conn,
  userId: string,
): Promise<InboxPendingCounts> {
  const row = await conn.query
    .selectFrom('inboxItems')
    .select((eb) => [eb.fn.countAll().as('count')])
    .where('userId', '=', userId)
    .where('kind', '=', 'decision')
    .where('archivedAt', 'is', null)
    .where('resolvedAt', 'is', null)
    .executeTakeFirst();
  return { decision: num(row?.count ?? 0) };
}

export function createInboxService(deps: {
  tx: TxRunner;
  ids: IdSource;
}): InboxService {
  return {
    async list(actor, query) {
      const conn = deps.tx.read();
      const viewer = await viewerOf(conn, actor);
      const kind = parseKind(query.kind);
      const archived = parseFlag(query.archived, 'archived') ?? false;
      const resolved = parseFlag(query.resolved, 'resolved');
      let select = conn.query
        .selectFrom('inboxItems')
        .selectAll()
        .where('userId', '=', viewer.userId)
        .where('archivedAt', archived ? 'is not' : 'is', null);
      if (kind) select = select.where('kind', '=', kind);
      if (resolved !== null)
        select = select.where('resolvedAt', resolved ? 'is not' : 'is', null);
      if (query.issueId) select = select.where('issueId', '=', query.issueId);
      if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        select = select.where((eb) =>
          eb.or([
            eb('updatedAt', '<', cursor.updatedAt),
            eb.and([
              eb('updatedAt', '=', cursor.updatedAt),
              eb('id', '<', cursor.id),
            ]),
          ]),
        );
      }
      const rows = await select
        .orderBy('updatedAt', 'desc')
        .orderBy('id', 'desc')
        .limit(PAGE_SIZE + 1)
        .execute();
      const page = await mapInboxItems(conn, rows.slice(0, PAGE_SIZE));
      const last = page[page.length - 1];
      return {
        data: page,
        unread: await unread(conn, viewer.userId),
        nextCursor:
          rows.length > PAGE_SIZE && last
            ? encodeCursor(last.updatedAt, last.id)
            : null,
      };
    },

    async unreadCount(actor) {
      const conn = deps.tx.read();
      return unread(conn, (await viewerOf(conn, actor)).userId);
    },

    async pendingCount(actor) {
      const conn = deps.tx.read();
      return pending(conn, (await viewerOf(conn, actor)).userId);
    },

    async mark(actor, itemId, action) {
      return deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        const values: Record<string, unknown> =
          action === 'read'
            ? { readAt: now() }
            : action === 'unread'
              ? { readAt: null }
              : action === 'archive'
                ? { archivedAt: now() }
                : { archivedAt: null };
        const result = await tx.conn.query
          .updateTable('inboxItems')
          .set(values)
          .where('id', '=', itemId)
          .where('userId', '=', viewer.userId)
          .execute();
        if ((result.updatedCount ?? 0) === 0) throw notFound('Inbox item');
        tx.emit({ type: 'inbox.changed', userId: viewer.userId });
        const row = await tx.conn.query
          .selectFrom('inboxItems')
          .selectAll()
          .where('id', '=', itemId)
          .executeTakeFirst();
        return (await mapInboxItems(tx.conn, row ? [row] : []))[0];
      });
    },

    async readAll(actor, kindInput) {
      const kind = parseKind(kindInput);
      return deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        let update = tx.conn.query
          .updateTable('inboxItems')
          .set({ readAt: now() })
          .where('userId', '=', viewer.userId)
          .where('readAt', 'is', null)
          .where('archivedAt', 'is', null);
        if (kind) update = update.where('kind', '=', kind);
        await update.execute();
        tx.emit({ type: 'inbox.changed', userId: viewer.userId });
        return unread(tx.conn, viewer.userId);
      });
    },

    async subscribe(actor, issueIdOrKey) {
      await deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        const issue = await requireVisibleIssue(tx.conn, viewer, issueIdOrKey);
        await subscribe(tx, deps.ids, issue.id, viewer.userId, 'manual');
        tx.emit({ type: 'issue.changed', issueId: issue.id });
      });
    },

    async unsubscribe(actor, issueIdOrKey) {
      await deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        const issue = await requireVisibleIssue(tx.conn, viewer, issueIdOrKey);
        await unsubscribe(tx, deps.ids, issue.id, viewer.userId);
        tx.emit({ type: 'issue.changed', issueId: issue.id });
      });
    },
  };
}
