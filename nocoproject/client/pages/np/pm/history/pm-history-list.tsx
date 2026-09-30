import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
} from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';

import { NpPulse } from '@/components/np-badges';
import { NpEmpty, NpListSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

import { fetchPmConversations } from '../../api-pm.js';
import { npKeys } from '../../constants.js';
import { useNpFormatters } from '../../format.js';
import type { PmConversationSummary } from '../../types-pm.js';
import {
  usePmConversationActions,
  usePmTitle,
} from '../conversation/use-pm-conversation.js';

export const PM_TITLE_MAX = 40;

/**
 * The member's project manager conversations (`protocol-pm-assistant.md` §5.4, NP-185), newest message first: in
 * the drawer's history view (`/pm` opens it there). Search covers titles and messages; "Archived" lists the archived ones.
 * Each row opens its conversation; its menu renames it in place or archives it (undo in the toast).
 */
export function PmHistoryList({
  activeId,
  onOpen,
}: {
  readonly activeId?: string | null;
  readonly onOpen: (conversationId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const pages = useInfiniteQuery({
    queryKey: npKeys.pmConversations({ q, archived }),
    queryFn: ({ pageParam, signal }) =>
      fetchPmConversations(api, { q, archived }, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const items = pages.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div className='flex min-h-0 flex-col gap-3' data-testid='np-pm-history'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative min-w-40 flex-1'>
          <SearchIcon
            className='pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground'
            aria-hidden='true'
          />
          <Input
            type='search'
            value={text}
            className='pl-8'
            placeholder={t('np.pmAssistant.history.search')}
            aria-label={t('np.pmAssistant.history.search')}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <Tabs
          value={archived ? 'archived' : 'active'}
          onValueChange={(value) => setArchived(value === 'archived')}
        >
          <TabsList aria-label={t('np.pmAssistant.history.filter')}>
            <TabsTrigger value='active'>
              {t('np.pmAssistant.history.active')}
            </TabsTrigger>
            <TabsTrigger value='archived'>
              {t('np.pmAssistant.history.archived')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {pages.isError && !pages.data ? (
        <NpLoadError
          title={t('np.pmAssistant.history.loadFailed')}
          error={pages.error}
          onRetry={() => void pages.refetch()}
        />
      ) : !pages.data ? (
        <NpListSkeleton rows={4} />
      ) : items.length === 0 ? (
        <NpEmpty
          icon={<MessagesSquareIcon />}
          title={
            q
              ? t('np.pmAssistant.history.noMatch')
              : archived
                ? t('np.pmAssistant.history.noArchived')
                : t('np.pmAssistant.history.empty')
          }
        />
      ) : (
        <ul
          className='flex flex-col gap-1'
          aria-label={t('np.pmAssistant.history.title')}
        >
          {items.map((item) => (
            <HistoryRow
              key={item.id}
              item={item}
              active={item.id === activeId}
              onOpen={() => onOpen(item.id)}
            />
          ))}
        </ul>
      )}
      {pages.hasNextPage ? (
        <Button
          variant='outline'
          size='sm'
          className='self-center'
          disabled={pages.isFetchingNextPage}
          onClick={() => void pages.fetchNextPage()}
        >
          {t('np.pmAssistant.history.more')}
        </Button>
      ) : null}
    </div>
  );
}

function HistoryRow({
  item,
  active,
  onOpen,
}: {
  readonly item: PmConversationSummary;
  readonly active: boolean;
  readonly onOpen: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const actions = usePmConversationActions();
  const shown = usePmTitle()(item.title);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(item.title);

  function saveTitle(): void {
    const next = title.trim().slice(0, PM_TITLE_MAX);
    setRenaming(false);
    if (!next || next === item.title) {
      setTitle(item.title);
      return;
    }
    actions.rename.mutate({ id: item.id, title: next });
  }

  return (
    <li
      className={cn(
        'group flex min-w-0 items-center gap-1 rounded-md pr-1 hover:bg-muted',
        active && 'bg-muted',
      )}
    >
      {renaming ? (
        <Input
          autoFocus
          value={title}
          maxLength={PM_TITLE_MAX}
          className='m-1 h-8'
          aria-label={t('np.pmAssistant.rename')}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              saveTitle();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setTitle(item.title);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button
          type='button'
          className='flex min-h-12 min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none'
          aria-current={active ? 'true' : undefined}
          onClick={onOpen}
        >
          <span className='flex w-full min-w-0 items-center gap-1.5'>
            {item.running ? <NpPulse /> : null}
            <span className='truncate text-sm font-medium' title={shown}>
              {shown}
            </span>
            {item.pendingPlanCount > 0 ? (
              <NpTag tone='amber' className='ml-auto'>
                {t('np.pmAssistant.history.pendingPlans', {
                  count: item.pendingPlanCount,
                })}
              </NpTag>
            ) : null}
          </span>
          <span className='flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground'>
            <time dateTime={item.lastMessageAt}>
              {format.relative(item.lastMessageAt)}
            </time>
            <span aria-hidden='true'>·</span>
            <span className='truncate'>
              {item.agent?.name ?? t('np.pmAssistant.agent.none')}
            </span>
          </span>
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('np.pmAssistant.history.actions', {
                title: shown,
              })}
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <PencilIcon />
              {t('np.pmAssistant.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                actions.archive.mutate({
                  id: item.id,
                  archived: !item.archivedAt,
                })
              }
            >
              {item.archivedAt ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {item.archivedAt
                ? t('np.pmAssistant.unarchive')
                : t('np.pmAssistant.archive')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
