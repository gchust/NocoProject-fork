/**
 * Inbox persistence (docs/phase1/iteration-1-contract.md §E): delivery with dedupe/merge, auto-resolve and
 * auto-archive, subscriptions. Only the notification module writes here; other modules emit domain events.
 *
 * Dedupe: an unresolved item with the same `dedupeKey` absorbs a new delivery — `count + 1` (restarting at 1 when it
 * had been archived), title/body/actor/payload replaced, marked unread and unarchived. PostgreSQL backs this with the
 * partial unique index `np_inbox_items_dedupe_unique`; a lost insert race merges into the winner.
 */
import type { Conn, Tx } from '../shared/db.js';
import {
  fromJson,
  iso,
  isoOrNull,
  isUniqueViolation,
  now,
  num,
  str,
  toJson,
  unique,
} from '../shared/db.js';
import type { IdSource } from '../shared/ids.js';
import type {
  ActorType,
  InboxItemTypeV4,
  InboxItemTypeV8,
  InboxItemV4,
  InboxKind,
  SubscriptionReason,
} from '../shared/protocol.js';
import { issuesByIds } from '../issue/issue.records.js';
import { inboxActions } from './inbox.actions.js';
import { mergeActionSources } from './inbox.pr-merge.js';

export interface NewInboxItem {
  readonly userId: string;
  readonly kind: InboxKind;
  readonly type: InboxItemTypeV8;
  readonly issueId: string | null;
  readonly title: string;
  readonly body: string;
  readonly actorType: ActorType | null;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly dedupeKey: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
}

export function dedupeKey(
  userId: string,
  type: InboxItemTypeV8,
  issueId: string | null,
): string {
  return `user:${userId}:${type}:${issueId ?? '-'}`;
}

async function merge(tx: Tx, item: NewInboxItem): Promise<boolean> {
  const existing = await tx.conn.query
    .selectFrom('inboxItems')
    .select(['id', 'count', 'archivedAt'])
    .where('dedupeKey', '=', item.dedupeKey)
    .where('resolvedAt', 'is', null)
    .executeTakeFirst();
  if (!existing) return false;
  await tx.conn.query
    .updateTable('inboxItems')
    .set({
      count: existing.archivedAt ? 1 : num(existing.count, 1) + 1,
      title: item.title.slice(0, 500),
      body: item.body,
      actorType: item.actorType,
      actorId: item.actorId,
      actorName: item.actorName,
      payload: toJson(item.payload),
      readAt: null,
      archivedAt: null,
      updatedAt: now(),
    })
    .where('id', '=', existing.id)
    .execute();
  return true;
}

/** Delivers (or merges) one item; returns the recipient. */
export async function deliver(
  tx: Tx,
  ids: IdSource,
  item: NewInboxItem,
): Promise<string> {
  if (await merge(tx, item)) return item.userId;
  const timestamp = now();
  try {
    await tx.conn.transaction(async (inner) => {
      await inner.query
        .insertInto('inboxItems')
        .values({
          id: ids.next(),
          userId: item.userId,
          kind: item.kind,
          type: item.type,
          issueId: item.issueId,
          title: item.title.slice(0, 500),
          body: item.body,
          actorType: item.actorType,
          actorId: item.actorId,
          actorName: item.actorName,
          count: 1,
          dedupeKey: item.dedupeKey,
          readAt: null,
          archivedAt: null,
          resolvedAt: null,
          payload: toJson(item.payload),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute();
    });
  } catch (error) {
    if (!isUniqueViolation(error) || !(await merge(tx, item))) throw error;
  }
  return item.userId;
}

/** Resolves unresolved items of `type` on an issue (only `userId`'s when given); returns the affected users. */
export async function resolveItems(
  tx: Tx,
  filter: { type: InboxItemTypeV8; issueId: string; userId?: string | null },
): Promise<string[]> {
  let select = tx.conn.query
    .selectFrom('inboxItems')
    .select(['id', 'userId'])
    .where('type', '=', filter.type)
    .where('issueId', '=', filter.issueId)
    .where('resolvedAt', 'is', null);
  if (filter.userId) select = select.where('userId', '=', filter.userId);
  return resolveRows(tx, await select.execute());
}

async function resolveRows(
  tx: Tx,
  rows: readonly Record<string, unknown>[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const timestamp = now();
  await tx.conn.query
    .updateTable('inboxItems')
    .set({ resolvedAt: timestamp, updatedAt: timestamp })
    .where('id', 'in', unique(rows.map((row) => str(row.id))))
    .where('resolvedAt', 'is', null)
    .execute();
  return unique(rows.map((row) => str(row.userId)));
}

/** Resolves unresolved items of `type` whose dedupe key ends with `suffix` (cards keyed by something other than the issue). */
export async function resolveByDedupeSuffix(
  tx: Tx,
  type: InboxItemTypeV8,
  suffix: string,
): Promise<string[]> {
  const rows = await tx.conn.query
    .selectFrom('inboxItems')
    .select(['id', 'userId', 'dedupeKey'])
    .where('type', '=', type)
    .where('resolvedAt', 'is', null)
    .execute();
  return resolveRows(
    tx,
    rows.filter((row) => (str(row.dedupeKey) ?? '').endsWith(suffix)),
  );
}

/** Archives the issue's live `run_failed` items (the issue reached review or a terminal status). */
export async function archiveRunFailed(
  tx: Tx,
  issueId: string,
): Promise<string[]> {
  const rows = await tx.conn.query
    .selectFrom('inboxItems')
    .select('userId')
    .where('type', '=', 'run_failed')
    .where('issueId', '=', issueId)
    .where('archivedAt', 'is', null)
    .execute();
  if (rows.length === 0) return [];
  const timestamp = now();
  await tx.conn.query
    .updateTable('inboxItems')
    .set({ archivedAt: timestamp, updatedAt: timestamp })
    .where('type', '=', 'run_failed')
    .where('issueId', '=', issueId)
    .where('archivedAt', 'is', null)
    .execute();
  return unique(rows.map((row) => str(row.userId)));
}

/**
 * Subscribes a user. An explicit unsubscribe is respected by automatic reasons, except `owner` (the owner always
 * follows) and `manual` (the user asked).
 */
export async function subscribe(
  tx: Tx,
  ids: IdSource,
  issueId: string,
  userId: string,
  reason: SubscriptionReason,
): Promise<void> {
  const existing = await tx.conn.query
    .selectFrom('issueSubscribers')
    .select(['id', 'unsubscribedAt'])
    .where('issueId', '=', issueId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  const timestamp = now();
  if (existing) {
    if (existing.unsubscribedAt && (reason === 'owner' || reason === 'manual'))
      await tx.conn.query
        .updateTable('issueSubscribers')
        .set({ unsubscribedAt: null, reason, updatedAt: timestamp })
        .where('id', '=', existing.id)
        .execute();
    return;
  }
  try {
    await tx.conn.transaction(async (inner) => {
      await inner.query
        .insertInto('issueSubscribers')
        .values({
          id: ids.next(),
          issueId,
          userId,
          reason,
          unsubscribedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute();
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

export async function unsubscribe(
  tx: Tx,
  ids: IdSource,
  issueId: string,
  userId: string,
): Promise<void> {
  const timestamp = now();
  const result = await tx.conn.query
    .updateTable('issueSubscribers')
    .set({ unsubscribedAt: timestamp, updatedAt: timestamp })
    .where('issueId', '=', issueId)
    .where('userId', '=', userId)
    .execute();
  if ((result.updatedCount ?? 0) > 0) return;
  await tx.conn.query
    .insertInto('issueSubscribers')
    .values({
      id: ids.next(),
      issueId,
      userId,
      reason: 'manual',
      unsubscribedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
}

export async function activeSubscribers(
  conn: Conn,
  issueId: string,
): Promise<string[]> {
  const rows = await conn.query
    .selectFrom('issueSubscribers')
    .select('userId')
    .where('issueId', '=', issueId)
    .where('unsubscribedAt', 'is', null)
    .execute();
  return unique(rows.map((row) => str(row.userId)));
}

export async function mapInboxItems(
  conn: Conn,
  rows: readonly Record<string, unknown>[],
): Promise<InboxItemV4[]> {
  const issues = await issuesByIds(
    conn,
    rows.map((row) => str(row.issueId)),
  );
  const merges = await mergeActionSources(
    conn,
    rows.map((row) => ({
      ...row,
      payload: fromJson<Record<string, unknown>>(row.payload),
    })),
    issues,
  );
  return rows.map((row) => {
    const issueId = str(row.issueId);
    const type = (str(row.type) ?? 'commented') as InboxItemTypeV4;
    const issueIdentifier = issueId
      ? (issues.get(issueId)?.identifier ?? null)
      : null;
    const stored = fromJson<Record<string, unknown>>(row.payload);
    const resolvedAt = isoOrNull(row.resolvedAt);
    // Iteration 3 §E: actions are computed on read, so items written earlier get them too.
    const actions = inboxActions({
      type,
      issueId,
      issueIdentifier,
      payload: stored,
      resolvedAt,
      merge: merges.get(str(row.id) ?? '') ?? null,
    });
    return {
      id: str(row.id) ?? '',
      kind: row.kind === 'decision' ? 'decision' : 'info',
      type,
      issueId,
      issueIdentifier,
      title: str(row.title) ?? '',
      body: str(row.body) ?? '',
      actorType: (str(row.actorType) as ActorType | null) ?? null,
      actorName: str(row.actorName),
      count: num(row.count, 1),
      readAt: isoOrNull(row.readAt),
      archivedAt: isoOrNull(row.archivedAt),
      resolvedAt,
      payload: { ...stored, actions },
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  });
}
