import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { toast } from '@/components/ui/toast';

import { npKeys } from '../constants.js';
import {
  actionBody,
  apiPath,
  externalUrl,
  inAppPath,
  resolveLocally,
} from '../inbox/decision-actions.js';
import { inboxItemLink } from '../inbox/inbox-model.js';
import { useActionLabel } from '../inbox/use-action-label.js';
import type { InboxItem } from '../types.js';
import type { InboxDecisionAction } from '../types-iter3.js';

/**
 * Patches one inbox item wherever it is cached under `npKeys.inbox`: the inbox's paged lists (`{ pages: [{ items }] }`)
 * and the issue page's decision list (`{ items }`). Other shapes (the unread counter) are left alone.
 */
export function patchInboxCaches(
  queryClient: QueryClient,
  itemId: string,
  change: (item: InboxItem) => InboxItem,
): void {
  const patchItems = (items: readonly InboxItem[]): InboxItem[] =>
    items.map((entry) => (entry.id === itemId ? change(entry) : entry));
  queryClient.setQueriesData<unknown>(
    { queryKey: npKeys.inbox },
    (current: unknown) => {
      if (!current || typeof current !== 'object') return current;
      const data = current as {
        pages?: { items?: readonly InboxItem[] }[];
        items?: readonly InboxItem[];
      };
      if (Array.isArray(data.pages)) {
        return {
          ...data,
          pages: data.pages.map((page) =>
            Array.isArray(page.items)
              ? { ...page, items: patchItems(page.items) }
              : page,
          ),
        };
      }
      if (Array.isArray(data.items)) {
        return { ...data, items: patchItems(data.items) };
      }
      return current;
    },
  );
}

export interface DecisionRunner {
  /** Carries out one action of a decision: a request, an in-app page, an external link or opening the issue. */
  readonly run: (
    item: InboxItem,
    action: InboxDecisionAction,
    comment: string,
  ) => void;
  /** The key of the action in flight on `itemId`, else null. */
  readonly pendingKey: (itemId: string) => string | null;
  readonly busy: boolean;
}

/**
 * Deciding from anywhere (nocosolution/guidelines/NocoSolution 前端规范.md §S15): the inbox's detail pane and the issue page's "Waiting for
 * you" section run the same code. A request resolves the item at once in every cached list (optimistic) and the request
 * follows; success toasts "{{action}} — done", failure toasts the localized reason and the refetch puts the item back.
 * Navigation actions mark the item read and leave: an external link opens in a new tab, an in-app page or the issue
 * opens in place.
 */
export function useDecisionRunner(
  options: {
    readonly onResolved?: (
      item: InboxItem,
      action: InboxDecisionAction,
    ) => void;
  } = {},
): DecisionRunner {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const actionLabel = useActionLabel();
  const [pending, setPending] = useState<{
    readonly itemId: string;
    readonly key: string;
  } | null>(null);

  const markRead = useMutation({
    mutationFn: (item: InboxItem) =>
      api.request<unknown>({
        path: `np/inbox/${encodeURIComponent(item.id)}/read`,
        method: 'POST',
      }),
    onMutate: (item) => {
      const now = new Date().toISOString();
      patchInboxCaches(queryClient, item.id, (entry) => ({
        ...entry,
        readAt: entry.readAt ?? now,
      }));
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.inbox }),
  });

  const decide = useMutation({
    mutationFn: ({
      action,
      comment,
    }: {
      item: InboxItem;
      action: InboxDecisionAction;
      comment: string;
    }) =>
      api.request<unknown, Record<string, unknown>>({
        path: apiPath(action.path ?? ''),
        method: action.method ?? 'POST',
        json: actionBody(action, comment),
      }),
    onMutate: ({ item, action }) => {
      setPending({ itemId: item.id, key: action.key });
      const now = new Date().toISOString();
      patchInboxCaches(queryClient, item.id, (entry) =>
        resolveLocally(entry, now),
      );
    },
    onSuccess: (_, { action, item }) => {
      options.onResolved?.(item, action);
      toast.add({
        type: 'success',
        title: t('np.inboxActions.done', {
          action: actionLabel(action, item.type),
          title: item.title,
        }),
      });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError && error.status === 409
              ? t('np.inboxActions.conflict')
              : t('np.common.requestFailed'),
      }),
    onSettled: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: npKeys.inbox });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void queryClient.invalidateQueries({ queryKey: ['np', 'issue'] });
      void queryClient.invalidateQueries({ queryKey: npKeys.approvals });
      void queryClient.invalidateQueries({ queryKey: npKeys.knowledge });
    },
  });

  function read(item: InboxItem): void {
    if (!item.readAt) markRead.mutate(item);
  }

  function run(
    item: InboxItem,
    action: InboxDecisionAction,
    comment: string,
  ): void {
    const external = externalUrl(action);
    if (external) {
      window.open(external, '_blank', 'noopener,noreferrer');
      read(item);
      return;
    }
    const page = inAppPath(action);
    if (page) {
      read(item);
      void navigate(page);
      return;
    }
    if (action.opensIssue || !action.path || action.method === 'GET') {
      read(item);
      const link = inboxItemLink(item);
      if (link) void navigate(link);
      return;
    }
    decide.mutate({ item, action, comment });
  }

  return {
    run,
    pendingKey: (itemId) =>
      pending && pending.itemId === itemId ? pending.key : null,
    busy: decide.isPending,
  };
}
