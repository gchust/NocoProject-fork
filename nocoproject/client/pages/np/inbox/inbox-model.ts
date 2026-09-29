import type { InboxAction } from '../api-inbox.js';
import type { InboxItem, InboxKind, InboxUnread } from '../types.js';

export function readInboxTab(value: string | null): InboxKind {
  return value === 'info' ? 'info' : 'decision';
}

/** The inbox list filter (nocosolution/frontend/frontend-standard.md §S2): both groups by default, or one of them. */
export type InboxFilter = 'all' | InboxKind;

export const INBOX_FILTERS: readonly InboxFilter[] = [
  'all',
  'decision',
  'info',
];

export function readInboxFilter(value: string | null): InboxFilter {
  return value === 'decision' || value === 'info' ? value : 'all';
}

/**
 * The decision group in reading order: what still waits first, settled decisions after (they stay listed, dimmed,
 * until archived); the server's newest-first order is kept inside each part.
 */
export function orderDecisions(items: readonly InboxItem[]): InboxItem[] {
  return [
    ...items.filter((item) => item.resolvedAt === null),
    ...items.filter((item) => item.resolvedAt !== null),
  ];
}

/** The id `step` places away from `currentId` in `ids` (j / k), clamped to the ends; the first id when none. */
export function stepSelection(
  ids: readonly string[],
  currentId: string | null,
  step: number,
): string | null {
  if (ids.length === 0) return null;
  const index = currentId ? ids.indexOf(currentId) : -1;
  if (index === -1) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, index + step))];
}

/** Unread counts per tab: the dedicated counter when it has loaded, else what the list response carried. */
export function inboxUnread(
  counter: InboxUnread | undefined,
  fromList: InboxUnread | null | undefined,
): InboxUnread {
  return counter ?? fromList ?? { decision: 0, info: 0 };
}

/** The two toggles a card offers: read ↔ unread, archive ↔ unarchive. */
export function inboxActionsFor(item: InboxItem): readonly InboxAction[] {
  return [
    item.readAt ? 'unread' : 'read',
    item.archivedAt ? 'unarchive' : 'archive',
  ];
}

/** The item as it looks right after `action`, for the optimistic list update. */
export function applyInboxActionLocally(
  item: InboxItem,
  action: InboxAction,
  now: string,
): InboxItem {
  switch (action) {
    case 'read':
      return { ...item, readAt: item.readAt ?? now };
    case 'unread':
      return { ...item, readAt: null };
    case 'archive':
      return { ...item, archivedAt: now };
    case 'unarchive':
      return { ...item, archivedAt: null };
  }
}

/** A decision is settled once the server marks it resolved (§E); it stays listed, dimmed, until archived. */
export function isSettled(item: InboxItem): boolean {
  return item.kind === 'decision' && item.resolvedAt !== null;
}

/** The navigation badge: the pending decision count, "99+" above 99 so the badge keeps its size, none at zero. */
export function inboxBadgeText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

const TITLE_COUNT = /^\(\d+\+?\) /;

/**
 * The browser tab title with the badge text in front (`(3) NocoProject`), or without it when `text` is null. Any
 * earlier count prefix is replaced, so applying it again (a re-render, a second writer) never stacks prefixes.
 */
export function inboxTitle(title: string, text: string | null): string {
  const base = title.replace(TITLE_COUNT, '');
  return text ? `(${text}) ${base}` : base;
}

/**
 * Where opening a card goes: its issue, or — for knowledge proposals and decisions without an issue — the knowledge
 * document (or the knowledge page for a proposed new document). Null when there is nothing to open.
 */
export function inboxItemLink(
  item: Pick<InboxItem, 'type' | 'issueId' | 'payload'>,
): string | null {
  if (item.issueId) return `/issues/${encodeURIComponent(item.issueId)}`;
  const type = item.type as string;
  if (type === 'knowledge_proposal' || type === 'knowledge_decided') {
    const docId = item.payload?.docId;
    return typeof docId === 'string' && docId
      ? `/knowledge/${encodeURIComponent(docId)}`
      : '/knowledge';
  }
  return null;
}
