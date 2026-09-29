import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from '@nocobase/i18n/client';
import { CalendarIcon, HourglassIcon, ListTreeIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link, type To, useLocation } from 'react-router';

import { NpLabelChip } from '@/components/np-labels';
import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpExecutor, NpPriorityLabel } from '@/components/np-badges';
import { cn } from '@/lib/utils';

import { useNpFormatters } from '../../format.js';
import type { IssueListItem } from '../../types.js';
import { NpProcessBadge } from '../process-fields.js';

export type IssueLink = (issue: IssueListItem) => To;

/**
 * The face of a board card; also rendered in the drag overlay (nocosolution/frontend/nocobase3-frontend-best-practices.md §8): identifier, the
 * design-first marker (iteration 4 §B) and priority icon, the title, dependency and sub-issue counts, labels, then owner and executor avatars with the due
 * date or last update. A card whose agent is working carries a primary bar on its left edge and a "working" pulse.
 */
export function BoardCardFace({
  issue,
  dragging = false,
  issueLink,
}: {
  readonly issue: IssueListItem;
  readonly dragging?: boolean;
  readonly issueLink?: IssueLink;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const location = useLocation();
  const working =
    issue.executorType === 'agent' && (issue.activeRunCount ?? 0) > 0;
  return (
    <div
      data-working={working ? 'true' : undefined}
      className={cn(
        'relative space-y-2.5 rounded-lg border bg-card p-4 text-card-foreground transition-[border-color,box-shadow] duration-150 hover:border-foreground/20',
        working && 'border-primary/30',
        dragging && 'shadow-md ring-2 ring-ring/50',
      )}
    >
      {working ? (
        <span
          aria-hidden='true'
          className='absolute top-3 bottom-3 left-0 w-0.5 rounded-full bg-primary'
        />
      ) : null}
      <div className='flex items-center justify-between gap-2 text-xs'>
        <span className='flex min-w-0 items-center gap-2'>
          <span className='font-mono text-muted-foreground'>
            {issue.identifier}
          </span>
          <NpProcessBadge issue={issue} />
        </span>
        {issue.priority !== 'none' ? (
          <NpPriorityLabel priority={issue.priority} />
        ) : null}
      </div>
      <Link
        to={
          issueLink?.(issue) ?? {
            pathname: encodeURIComponent(issue.id),
            search: location.search,
          }
        }
        className='line-clamp-3 block text-sm font-medium wrap-anywhere hover:underline focus-visible:underline'
        onPointerDown={(event) => event.stopPropagation()}
      >
        {issue.title}
      </Link>
      {(issue.blockedCount ?? 0) > 0 || (issue.subtaskCount ?? 0) > 0 ? (
        <div className='flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          {(issue.blockedCount ?? 0) > 0 ? (
            <span className='inline-flex items-center gap-1'>
              <HourglassIcon className='size-3' aria-hidden='true' />
              {t('np.subtasks.waiting', { count: issue.blockedCount })}
            </span>
          ) : null}
          {(issue.subtaskCount ?? 0) > 0 ? (
            <span className='inline-flex items-center gap-1'>
              <ListTreeIcon className='size-3' aria-hidden='true' />
              {t('np.board.subtaskCount', { count: issue.subtaskCount })}
            </span>
          ) : null}
        </div>
      ) : null}
      {issue.labels && issue.labels.length > 0 ? (
        <div className='flex flex-wrap gap-1'>
          {issue.labels.map((label) => (
            <NpLabelChip key={label.id} label={label} />
          ))}
        </div>
      ) : null}
      <div className='flex items-center gap-2 text-xs text-muted-foreground'>
        {issue.ownerName ? (
          <NpActorAvatar
            type='user'
            name={issue.ownerName}
            size='xs'
            decorative={false}
          />
        ) : null}
        <span className='flex min-w-0 flex-1'>
          <NpExecutor
            type={issue.executorType}
            name={issue.executorName}
            activeRunCount={issue.activeRunCount}
          />
        </span>
        {issue.dueDate ? (
          <span
            className='inline-flex shrink-0 items-center gap-1'
            title={t('np.dates.due')}
          >
            <CalendarIcon className='size-3' aria-hidden='true' />
            {format.date(issue.dueDate)}
          </span>
        ) : (
          <span className='shrink-0' title={format.dateTime(issue.updatedAt)}>
            {format.relative(issue.updatedAt)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A draggable card. The title link opens the issue; dragging starts after a few pixels so a click stays a click, and
 * on a touch screen after a press-and-hold, so the page keeps native touch scrolling (`touch-manipulation`).
 */
export function BoardCard({
  issue,
  issueLink,
}: {
  readonly issue: IssueListItem;
  readonly issueLink?: IssueLink;
}): ReactElement {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { statusKey: issue.statusKey } });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'cursor-grab touch-manipulation rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing',
        isDragging && 'opacity-40',
      )}
      {...attributes}
      aria-roledescription={t('np.board.cardRole')}
      aria-label={`${issue.identifier} ${issue.title}`}
      {...listeners}
    >
      <BoardCardFace issue={issue} issueLink={issueLink} />
    </div>
  );
}
