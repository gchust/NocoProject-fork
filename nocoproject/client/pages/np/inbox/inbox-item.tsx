import { useTranslation } from '@nocobase/i18n/client';
import { CheckCircle2Icon, MoreHorizontalIcon } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

import type { InboxAction } from '../api-inbox.js';
import { InboxTypeIcon } from '../decision/decision-meta.js';
import { useDecisionSentence } from '../decision/decision-model.js';
import { useNpFormatters } from '../format.js';
import type { InboxItem } from '../types.js';
import { INBOX_ACTION_ICON } from './inbox-icons.js';
import { inboxActionsFor, isSettled } from './inbox-model.js';

/**
 * One compact card of the inbox list (nocosolution/frontend/frontend-standard.md §S2). Selecting it shows its context in the detail
 * pane (and marks it read); Enter on a focused card opens its issue. A decision that still waits carries an amber
 * bar, an unread card a primary dot and a bold title (with a text alternative), a settled decision is dimmed with a
 * check. The menu button and a right-click offer read / unread and archive / unarchive.
 */
export function InboxItemCard({
  item,
  selected,
  busy,
  fresh,
  onSelect,
  onOpen,
  onAction,
}: {
  readonly item: InboxItem;
  readonly selected: boolean;
  readonly busy: boolean;
  /** Arrived by a realtime push after the list first loaded: slides in (§6). */
  readonly fresh?: boolean;
  readonly onSelect: (item: InboxItem) => void;
  readonly onOpen: (item: InboxItem) => void;
  readonly onAction: (item: InboxItem, action: InboxAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const sentence = useDecisionSentence();
  const unread = item.readAt === null;
  const settled = isSettled(item);
  const waiting = item.kind === 'decision' && !settled;
  const actions = inboxActionsFor(item);
  const label = (action: InboxAction): string =>
    t(`np.inbox.actions.${action}`);
  const body = sentence(item);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      onOpen(item);
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        data-inbox-item={item.id}
        data-selected={selected ? 'true' : undefined}
        className={cn(
          'group relative flex items-start gap-3 rounded-lg border border-transparent p-3 pr-2 transition-[background-color,border-color,opacity] duration-200',
          selected ? 'border-border bg-card shadow-xs' : 'hover:bg-accent/60',
          settled && 'opacity-55',
          fresh &&
            'animate-in duration-200 fade-in slide-in-from-top-1 motion-reduce:animate-none',
        )}
      >
        <span
          aria-hidden='true'
          className={cn(
            'absolute top-3 bottom-3 left-0 w-0.5 rounded-full',
            selected
              ? 'bg-primary'
              : waiting
                ? 'bg-attention'
                : 'bg-transparent',
          )}
        />
        <span className='mt-0.5 flex shrink-0 flex-col items-center gap-1.5'>
          {settled ? (
            <CheckCircle2Icon
              className='size-4 text-success'
              aria-hidden='true'
            />
          ) : (
            <InboxTypeIcon item={item} />
          )}
        </span>
        <button
          type='button'
          aria-current={selected ? 'true' : undefined}
          className='block min-w-0 flex-1 space-y-1 text-left focus-visible:outline-none'
          onClick={() => onSelect(item)}
          onKeyDown={onKeyDown}
        >
          <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
            {item.issueIdentifier ? (
              <span className='shrink-0 font-mono'>{item.issueIdentifier}</span>
            ) : null}
            <span className='truncate'>
              {t(`np.inbox.types.${item.type}`, { defaultValue: item.type })}
            </span>
            {item.count > 1 ? (
              <span className='shrink-0 tabular-nums'>
                {t('np.inbox.count', { count: item.count })}
              </span>
            ) : null}
            {settled ? (
              <span className='shrink-0'>{t('np.inbox.resolved')}</span>
            ) : null}
            <time
              className='ml-auto shrink-0 tabular-nums'
              dateTime={item.updatedAt}
              title={format.dateTime(item.updatedAt)}
            >
              {format.relative(item.updatedAt)}
            </time>
          </span>
          <span
            className={cn(
              'flex items-center gap-1.5 text-sm group-focus-within:underline',
              unread ? 'font-semibold' : 'font-normal',
            )}
          >
            {unread ? (
              <span className='size-1.5 shrink-0 rounded-full bg-primary'>
                <span className='sr-only'>{t('np.inbox.unread')}</span>
              </span>
            ) : null}
            <span className='truncate'>{item.title}</span>
          </span>
          {body ? (
            <span className='line-clamp-1 text-sm text-muted-foreground wrap-anywhere'>
              {body}
            </span>
          ) : null}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant='ghost'
                size='icon-xs'
                disabled={busy}
                className='opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100'
                aria-label={t('np.inbox.actionsFor', { title: item.title })}
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuGroup>
              {actions.map((action) => {
                const Icon = INBOX_ACTION_ICON[action];
                return (
                  <DropdownMenuItem
                    key={action}
                    onClick={() => onAction(item, action)}
                  >
                    <Icon />
                    {label(action)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          {actions.map((action) => {
            const Icon = INBOX_ACTION_ICON[action];
            return (
              <ContextMenuItem
                key={action}
                disabled={busy}
                onClick={() => onAction(item, action)}
              >
                <Icon />
                {label(action)}
              </ContextMenuItem>
            );
          })}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
