import { useTranslation } from '@nocobase/i18n/client';
import type { UseInfiniteQueryResult } from '@tanstack/react-query';
import { InboxIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpEmpty, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import type { InboxAction } from '../api-inbox.js';
import type { InboxItem, InboxKind, InboxUnread } from '../types.js';
import { InboxItemCard } from './inbox-item.js';
import { INBOX_FILTERS, type InboxFilter } from './inbox-model.js';

type PagedQuery = Pick<
  UseInfiniteQueryResult,
  | 'isError'
  | 'isFetching'
  | 'error'
  | 'refetch'
  | 'hasNextPage'
  | 'isFetchingNextPage'
  | 'fetchNextPage'
>;

/**
 * The inbox's left column (nocosolution/guidelines/frontend-standard.md §S2): the filter tabs with their counts, "show archived", and
 * the items as two groups — "Needs my decision" first, then "Notifications" — each a labelled list with its own "load more". The keyboard
 * hint sits at the bottom. The decision tab counts pending decisions, read or not — the same number as the navigation
 * badge (NP-180: it showed the unread count, so a badge of 6 sat beside a tab of 0); the notification tab counts unread.
 */
export function InboxList({
  filter,
  archived,
  unread,
  pending,
  decisions,
  notices,
  decisionQuery,
  noticeQuery,
  selectedId,
  fresh,
  busy,
  onFilter,
  onArchived,
  onSelect,
  onOpen,
  onAction,
}: {
  readonly filter: InboxFilter;
  readonly archived: boolean;
  readonly unread: InboxUnread;
  /** Pending decisions (`GET /np/inbox/pending-count`), shown on the decision tab. */
  readonly pending: number;
  readonly decisions: readonly InboxItem[] | undefined;
  readonly notices: readonly InboxItem[] | undefined;
  readonly decisionQuery: PagedQuery;
  readonly noticeQuery: PagedQuery;
  readonly selectedId: string | null;
  readonly fresh: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onFilter: (filter: InboxFilter) => void;
  readonly onArchived: (archived: boolean) => void;
  readonly onSelect: (item: InboxItem) => void;
  readonly onOpen: (item: InboxItem) => void;
  readonly onAction: (item: InboxItem, action: InboxAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const groups: {
    kind: InboxKind;
    items: readonly InboxItem[] | undefined;
    query: PagedQuery;
  }[] = [];
  if (filter !== 'info')
    groups.push({ kind: 'decision', items: decisions, query: decisionQuery });
  if (filter !== 'decision')
    groups.push({ kind: 'info', items: notices, query: noticeQuery });
  const loaded = groups.every((group) => group.items !== undefined);
  const empty =
    loaded && groups.every((group) => (group.items ?? []).length === 0);
  const failed = groups.find(
    (group) => group.query.isError && !group.query.isFetching && !group.items,
  );

  return (
    <>
      <div className='shrink-0 space-y-2 border-b px-3 py-2.5'>
        <Tabs
          value={filter}
          onValueChange={(value) => onFilter(value as InboxFilter)}
        >
          <TabsList className='w-full'>
            {INBOX_FILTERS.map((value) => {
              const count =
                value === 'all'
                  ? 0
                  : value === 'decision'
                    ? pending
                    : unread.info;
              return (
                <TabsTrigger key={value} value={value}>
                  {value === 'all'
                    ? t('np.inboxPane.all')
                    : t(`np.inbox.tabs.${value}`)}
                  {count > 0 ? (
                    <NpTag
                      tone={value === 'decision' ? 'amber' : 'grey'}
                      className='px-1.5 py-0 tabular-nums'
                      aria-label={
                        value === 'decision'
                          ? t('np.inbox.pendingDecisions', { count })
                          : t('np.inbox.unreadCount', { count })
                      }
                    >
                      {count}
                    </NpTag>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
        <div className='flex items-center justify-end gap-2'>
          <Switch
            id='np-inbox-archived'
            size='sm'
            checked={archived}
            onCheckedChange={onArchived}
          />
          <Label
            htmlFor='np-inbox-archived'
            className='text-xs text-muted-foreground'
          >
            {t('np.inbox.showArchived')}
          </Label>
        </div>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto px-2 py-3'>
        {failed ? (
          <div className='px-1'>
            <NpLoadError
              title={t('np.inbox.loadFailed')}
              error={failed.query.error}
              onRetry={() => void failed.query.refetch()}
            />
          </div>
        ) : !loaded ? (
          <div
            role='status'
            aria-label={t('status.loading')}
            className='space-y-2 px-1'
          >
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className='h-16 w-full rounded-lg' />
            ))}
          </div>
        ) : empty ? (
          <NpEmpty
            icon={<InboxIcon />}
            title={
              archived
                ? t('np.inbox.emptyArchived')
                : filter === 'all'
                  ? t('np.inboxPane.emptyAll')
                  : t(`np.inbox.empty.${filter}`)
            }
            description={t('np.inbox.emptyDescription')}
            className='mx-1 border-none bg-transparent'
          />
        ) : (
          <div className='space-y-5'>
            {groups.map((group) =>
              (group.items ?? []).length === 0 && filter === 'all' ? null : (
                <section
                  key={group.kind}
                  aria-labelledby={`np-inbox-group-${group.kind}`}
                  className='space-y-1'
                >
                  <h2
                    id={`np-inbox-group-${group.kind}`}
                    className='flex items-center gap-2 px-3 text-xs font-medium tracking-wider text-muted-foreground uppercase'
                  >
                    {t(`np.inbox.tabs.${group.kind}`)}
                    <span className='tabular-nums'>
                      {(group.items ?? []).length}
                    </span>
                  </h2>
                  <ul
                    aria-label={t(`np.inbox.tabs.${group.kind}`)}
                    className='space-y-0.5'
                  >
                    {(group.items ?? []).map((item) => (
                      <li key={item.id}>
                        <InboxItemCard
                          item={item}
                          selected={item.id === selectedId}
                          busy={busy}
                          fresh={fresh.has(item.id)}
                          onSelect={onSelect}
                          onOpen={onOpen}
                          onAction={onAction}
                        />
                      </li>
                    ))}
                  </ul>
                  {group.query.hasNextPage ? (
                    <div className='flex justify-center pt-1'>
                      <Button
                        variant='ghost'
                        size='sm'
                        disabled={group.query.isFetchingNextPage}
                        onClick={() => void group.query.fetchNextPage()}
                      >
                        {group.query.isFetchingNextPage ? (
                          <Spinner data-icon='inline-start' />
                        ) : null}
                        {t('np.pagination.loadMore')}
                      </Button>
                    </div>
                  ) : null}
                </section>
              ),
            )}
          </div>
        )}
      </div>
      <p className='hidden shrink-0 items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground lg:flex'>
        <span className='inline-flex items-center gap-1'>
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
          {t('np.inboxPane.keyMove')}
        </span>
        <span className='inline-flex items-center gap-1'>
          <Kbd>E</Kbd>
          {t('np.inboxPane.keyArchive')}
        </span>
        <span className='inline-flex items-center gap-1'>
          <Kbd>Enter</Kbd>
          {t('np.inboxPane.keyOpen')}
        </span>
      </p>
    </>
  );
}
