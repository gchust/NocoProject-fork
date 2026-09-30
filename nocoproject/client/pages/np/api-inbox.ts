import type { ApiClient } from '@nocobase/app-client';

import type {
  InboxItem,
  InboxKind,
  InboxListResponse,
  InboxPending,
  InboxUnread,
} from './types.js';

/** Inbox endpoints (`docs/phase1/iteration-1-contract.md` §E). */

const id = (value: string): string => encodeURIComponent(value);

export type InboxAction = 'read' | 'unread' | 'archive' | 'unarchive';

export interface InboxPage {
  readonly items: readonly InboxItem[];
  readonly unread: InboxUnread | null;
  /** Null on the last page (and whenever the server sends none). */
  readonly nextCursor: string | null;
}

export async function fetchInbox(
  api: ApiClient,
  filters: {
    readonly kind: InboxKind;
    readonly archived: boolean;
    /** `false` for what still waits (the issue page's decisions); omitted for both. */
    readonly resolved?: boolean;
    /** Only the items about one issue (`GET /np/inbox?issueId=`, nocosolution/guidelines/frontend-standard.md §S3). */
    readonly issueId?: string;
  },
  signal?: AbortSignal,
  cursor?: string | null,
): Promise<InboxPage> {
  const body = await api.request<InboxListResponse>({
    path: 'np/inbox',
    query: {
      kind: filters.kind,
      archived: String(filters.archived),
      resolved:
        filters.resolved === undefined ? undefined : String(filters.resolved),
      issueId: filters.issueId,
      cursor: cursor ?? undefined,
    },
    signal,
  });
  return {
    items: body.data,
    unread: body.unread ?? null,
    nextCursor:
      typeof body.nextCursor === 'string' && body.nextCursor
        ? body.nextCursor
        : null,
  };
}

/** `GET /np/inbox/unread-count`; accepts `{ data: { decision, info } }` or the counts at the top level. */
export async function fetchInboxUnread(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<InboxUnread> {
  const body = await api.request<
    { data?: Partial<InboxUnread> } & Partial<InboxUnread>
  >({ path: 'np/inbox/unread-count', signal });
  const counts = body.data ?? body;
  return { decision: counts.decision ?? 0, info: counts.info ?? 0 };
}

/** `GET /np/inbox/pending-count`; accepts `{ data: { decision } }` or the count at the top level. */
export async function fetchInboxPending(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<InboxPending> {
  const body = await api.request<
    { data?: Partial<InboxPending> } & Partial<InboxPending>
  >({ path: 'np/inbox/pending-count', signal });
  return { decision: (body.data ?? body).decision ?? 0 };
}

export async function applyInboxAction(
  api: ApiClient,
  itemId: string,
  action: InboxAction,
): Promise<void> {
  await api.request<unknown>({
    path: `np/inbox/${id(itemId)}/${action}`,
    method: 'POST',
  });
}

export async function markAllInboxRead(
  api: ApiClient,
  kind?: InboxKind,
): Promise<void> {
  await api.request<unknown, { kind?: InboxKind }>({
    path: 'np/inbox/read-all',
    method: 'POST',
    json: kind ? { kind } : {},
  });
}
