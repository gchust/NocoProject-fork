import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { CheckCheckIcon } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useNavigate, useSearchParams } from 'react-router';

import { isEditableTarget } from '@/components/np-shortcut-keys';
import { NpShortcuts } from '@/components/np-shortcuts';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import {
  type InboxAction,
  type InboxPage,
  applyInboxAction,
  fetchInbox,
  fetchInboxUnread,
  markAllInboxRead,
} from '../api-inbox.js';
import { npKeys } from '../constants.js';
import {
  patchInboxCaches,
  useDecisionRunner,
} from '../decision/use-decision.js';
import type { InboxItem, InboxKind, InboxTopicPayload } from '../types.js';
import { useRealtimeTopic } from '../use-realtime.js';
import { InboxDetail } from './inbox-detail.js';
import { InboxList } from './inbox-list.js';
import {
  applyInboxActionLocally,
  inboxItemLink,
  inboxUnread,
  orderDecisions,
  readInboxFilter,
  stepSelection,
} from './inbox-model.js';

type InboxPages = InfiniteData<InboxPage, unknown>;

function useInboxPages(kind: InboxKind, archived: boolean, enabled: boolean) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: npKeys.inboxList(kind, archived),
    queryFn: ({ pageParam, signal }) =>
      fetchInbox(api, { kind, archived }, signal, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: InboxPage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

function itemsOf(data: InboxPages | undefined): InboxItem[] | undefined {
  return data?.pages.flatMap((page) => page.items);
}

/**
 * Route `/inbox` (nocosolution/NocoSolution 前端规范.md §S2): a master–detail inbox. The left column lists the viewer's items in
 * two groups — "Needs my decision" first, then "Notifications" — with unread and "needs you" states; the right pane shows the selected item
 * with everything needed to decide (the issue, the delivery or proposal in full, the latest activity) under a sticky
 * action bar. The filter (`?tab=` all / decision / info), "show archived" (`?archived=1`) and the selection
 * (`?item=`) live in the URL, so a narrow screen shows the list, then the detail with a back button.
 *
 * Keyboard: `j` / `k` move the selection, `e` archives it, Enter opens its issue. Decisions run through
 * `useDecisionRunner` (shared with the issue page): the item resolves at once and the request follows. The
 * `np:inbox` user topic invalidates everything here; items that arrive by push slide in.
 */
export default function InboxPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filter = readInboxFilter(params.get('tab'));
  const archived = params.get('archived') === '1';
  const selectedParam = params.get('item');

  const decisions = useInboxPages('decision', archived, filter !== 'info');
  const notices = useInboxPages('info', archived, filter !== 'decision');
  const counter = useQuery({
    queryKey: npKeys.inboxUnread,
    queryFn: ({ signal }) => fetchInboxUnread(api, signal),
  });
  const unread = inboxUnread(
    counter.data,
    decisions.data?.pages[0]?.unread ?? notices.data?.pages[0]?.unread,
  );

  useRealtimeTopic<InboxTopicPayload>('np:inbox', () => {
    void queryClient.invalidateQueries({ queryKey: npKeys.inbox });
  });

  const decisionItems = useMemo(() => {
    const items = itemsOf(decisions.data);
    return items ? orderDecisions(items) : undefined;
  }, [decisions.data]);
  const noticeItems = itemsOf(notices.data);
  const visible = useMemo(
    () => [
      ...(filter !== 'info' ? (decisionItems ?? []) : []),
      ...(filter !== 'decision' ? (noticeItems ?? []) : []),
    ],
    [filter, decisionItems, noticeItems],
  );
  const selected =
    visible.find((item) => item.id === selectedParam) ?? visible[0] ?? null;

  // Items present when the list first loaded do not animate; later arrivals (realtime pushes) slide in. The first
  // non-empty list is remembered while rendering (derived state, no effect).
  const [initialIds, setInitialIds] = useState<ReadonlySet<string> | null>(
    null,
  );
  if (initialIds === null && visible.length > 0) {
    setInitialIds(new Set(visible.map((item) => item.id)));
  }
  const fresh = useMemo(
    () =>
      new Set(
        initialIds
          ? visible
              .filter((item) => !initialIds.has(item.id))
              .map((item) => item.id)
          : [],
      ),
    [initialIds, visible],
  );

  const act = useMutation({
    mutationFn: ({ item, action }: { item: InboxItem; action: InboxAction }) =>
      applyInboxAction(api, item.id, action),
    onMutate: ({ item, action }) => {
      const now = new Date().toISOString();
      patchInboxCaches(queryClient, item.id, (entry) =>
        applyInboxActionLocally(entry, action, now),
      );
    },
    onSuccess: (_, { action }) => {
      if (action === 'archive' || action === 'unarchive') {
        toast.add({
          type: 'success',
          title:
            action === 'archive'
              ? t('np.inbox.archived')
              : t('np.inbox.unarchived'),
        });
      }
    },
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.inbox }),
  });
  const runner = useDecisionRunner();

  const readAll = useMutation({
    mutationFn: () =>
      markAllInboxRead(api, filter === 'all' ? undefined : filter),
    onSuccess: () =>
      toast.add({ type: 'success', title: t('np.inbox.allRead') }),
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.inbox }),
  });

  function setParam(name: string, value: string | null): void {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  function select(item: InboxItem): void {
    setParam('item', item.id);
    if (!item.readAt) act.mutate({ item, action: 'read' });
  }

  function open(item: InboxItem): void {
    if (!item.readAt) act.mutate({ item, action: 'read' });
    const link = inboxItemLink(item);
    if (link) void navigate(link);
  }

  function archive(item: InboxItem): void {
    const ids = visible.map((entry) => entry.id);
    const next = stepSelection(ids, item.id, 1);
    act.mutate({ item, action: item.archivedAt ? 'unarchive' : 'archive' });
    setParam('item', next && next !== item.id ? next : null);
  }

  // j / k / e / Enter, ignored while typing, with a modifier, or when a dialog is open.
  const keysRef = useRef({ visible, selected, select, archive, open });
  useEffect(() => {
    keysRef.current = { visible, selected, select, archive, open };
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return;
      const current = keysRef.current;
      const key = event.key.toLowerCase();
      if (key === 'j' || key === 'k') {
        const id = stepSelection(
          current.visible.map((item) => item.id),
          current.selected?.id ?? null,
          key === 'j' ? 1 : -1,
        );
        const item = current.visible.find((entry) => entry.id === id);
        if (!item) return;
        event.preventDefault();
        current.select(item);
        document
          .querySelector(`[data-inbox-item="${CSS.escape(item.id)}"] button`)
          ?.scrollIntoView?.({ block: 'nearest' });
      } else if (key === 'e' && current.selected) {
        event.preventDefault();
        current.archive(current.selected);
      } else if (
        event.key === 'Enter' &&
        current.selected &&
        (event.target === document.body ||
          event.target === document.documentElement)
      ) {
        event.preventDefault();
        current.open(current.selected);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const loadingAny =
    (decisions.isFetching && decisions.data) ||
    (notices.isFetching && notices.data);
  const readAllCount =
    filter === 'all' ? unread.decision + unread.info : unread[filter];

  return (
    <TooltipProvider>
      <div className='flex h-full min-h-0 flex-col'>
        <div className='shrink-0 border-b px-6 py-5 md:px-8'>
          <PageHeader
            title={t('np.inbox.title')}
            description={t('np.inbox.description')}
            actions={
              <>
                {loadingAny ? (
                  <Spinner
                    className='size-4 text-muted-foreground'
                    aria-label={t('status.loading')}
                  />
                ) : null}
                <NpShortcuts showTrigger />
                <Button
                  variant='outline'
                  disabled={readAll.isPending || readAllCount === 0}
                  onClick={() => readAll.mutate()}
                >
                  {readAll.isPending ? (
                    <Spinner data-icon='inline-start' />
                  ) : (
                    <CheckCheckIcon data-icon='inline-start' />
                  )}
                  {t('np.inbox.readAll')}
                </Button>
              </>
            }
          />
        </div>
        <div className='flex min-h-0 flex-1'>
          <div
            className={cn(
              'flex min-h-0 w-full flex-col border-r bg-sidebar/60 lg:w-[26rem] lg:shrink-0',
              selectedParam ? 'max-lg:hidden' : undefined,
            )}
          >
            <InboxList
              filter={filter}
              archived={archived}
              unread={unread}
              decisions={decisionItems}
              notices={noticeItems}
              decisionQuery={decisions}
              noticeQuery={notices}
              selectedId={selected?.id ?? null}
              fresh={fresh}
              busy={act.isPending}
              onFilter={(value) =>
                setParam('tab', value === 'all' ? null : value)
              }
              onArchived={(value) => setParam('archived', value ? '1' : null)}
              onSelect={select}
              onOpen={open}
              onAction={(item, action) =>
                action === 'archive' || action === 'unarchive'
                  ? archive(item)
                  : act.mutate({ item, action })
              }
            />
          </div>
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 overflow-y-auto',
              selectedParam ? undefined : 'max-lg:hidden',
            )}
          >
            <InboxDetail
              item={selected}
              runner={runner}
              busy={act.isPending}
              onBack={() => setParam('item', null)}
              onAction={(item, action) =>
                action === 'archive' || action === 'unarchive'
                  ? archive(item)
                  : act.mutate({ item, action })
              }
              onOpen={open}
            />
          </div>
        </div>
      </div>
      <Outlet />
    </TooltipProvider>
  );
}
