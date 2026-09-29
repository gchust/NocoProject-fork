import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, useMemo, useState } from 'react';

import { NpStartDialog } from '@/components/np-start-dialog';
import { NpVirtualList } from '@/components/np-virtual-list';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { NP_TONE_DOT_CLASS } from '@/components/np-tones';
import { cn } from '@/lib/utils';

import { statusLabelKey, statusTone } from '../../constants.js';
import type {
  BoardGroup,
  IssueListItem,
  StatusCatalogEntry,
} from '../../types.js';
import { BoardCard, BoardCardFace, type IssueLink } from './board-card.js';
import {
  type BoardColumn,
  buildBoardColumns,
  resolveDropStatus,
  boardCollisionDetection,
} from './board-model.js';
import { useBoardMove } from './use-board-move.js';

/** "Load more" of one column (§D), from `useBoardPages`. */
export interface BoardColumnMore {
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
}

function Column({
  column,
  catalog,
  issueLink,
  more,
  fill = false,
}: {
  readonly column: BoardColumn;
  readonly catalog: readonly StatusCatalogEntry[];
  readonly issueLink?: IssueLink;
  readonly more?: BoardColumnMore;
  readonly fill?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${column.statusKey}`,
  });
  const headingId = `np-board-column-${column.statusKey}`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'flex w-[18rem] shrink-0 flex-col rounded-xl bg-muted/40 transition-colors',
        fill && 'h-full',
        isOver && 'bg-muted ring-2 ring-ring/40',
      )}
    >
      <h3
        id={headingId}
        className='flex items-center gap-2 px-3 pt-3 pb-2 text-sm font-medium'
      >
        <span
          aria-hidden='true'
          className={cn(
            'size-2 shrink-0 rounded-full',
            NP_TONE_DOT_CLASS[statusTone(column.statusKey, catalog)],
          )}
        />
        <span>
          {t(statusLabelKey(column.statusKey), {
            defaultValue: column.statusKey,
          })}
        </span>
        <span className='text-xs text-muted-foreground tabular-nums'>
          {more?.hasMore
            ? t('np.pagination.countMore', { count: column.issues.length })
            : column.issues.length}
        </span>
      </h3>
      <SortableContext
        id={column.statusKey}
        items={column.issues.map((issue) => issue.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className='flex min-h-24 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 pb-2'
        >
          {column.issues.length === 0 ? (
            <p className='flex flex-1 items-center justify-center rounded-lg border border-dashed p-4 text-xs text-muted-foreground'>
              {t('np.board.emptyColumn')}
            </p>
          ) : (
            <NpVirtualList
              as='ul'
              gapClassName='space-y-2'
              items={column.issues}
              itemKey={(issue) => issue.id}
              renderItem={(issue) => (
                <BoardCard issue={issue} issueLink={issueLink} />
              )}
            />
          )}
          {more?.hasMore ? (
            <Button
              variant='ghost'
              size='sm'
              className='w-full'
              disabled={more.loading}
              onClick={more.onLoadMore}
            >
              {more.loading ? <Spinner data-icon='inline-start' /> : null}
              {t('np.pagination.loadMore')}
            </Button>
          ) : null}
        </div>
      </SortableContext>
    </section>
  );
}

/**
 * The issue board (§J 1): a column per workflow status, cards dragged between columns to change status. Order inside
 * a column follows the server (latest activity first) and is not persisted, so a drop within the same column does
 * nothing. A column shows its first page with "load more" (iteration 3 §D) and virtualizes past 100 cards (§H 8).
 */
export function IssueBoard({
  groups,
  catalog,
  issueLink,
  columnMore,
  fill = false,
}: {
  readonly groups: readonly BoardGroup[];
  readonly catalog: readonly StatusCatalogEntry[];
  /** Where a card's title links; defaults to the issue beside the current page, keeping the query string. */
  readonly issueLink?: IssueLink;
  /** Per status key; a column without an entry has no "load more". */
  readonly columnMore?: Readonly<Record<string, BoardColumnMore>>;
  /**
   * Fill the parent's height (nocosolution/frontend/nocobase3-frontend-best-practices.md §8): the page does not scroll, each column scrolls on its
   * own and the columns scroll sideways. The parent must bound the height.
   */
  readonly fill?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const move = useBoardMove(catalog);
  const [active, setActive] = useState<IssueListItem | null>(null);
  const columns = useMemo(
    () => buildBoardColumns(catalog, groups, move.overrides),
    [catalog, groups, move.overrides],
  );
  const sensors = useSensors(
    // A mouse drags after a few pixels; a finger drags only after a press-and-hold, so a swipe on a card scrolls
    // its column instead of picking the card up (NP-144).
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const findIssue = (id: string): IssueListItem | undefined =>
    columns.flatMap((column) => column.issues).find((issue) => issue.id === id);
  const statusName = (statusKey: string | null): string =>
    statusKey ? t(statusLabelKey(statusKey), { defaultValue: statusKey }) : '';
  const announcements: Announcements = {
    onDragStart: ({ active: item }) =>
      t('np.board.announce.start', {
        identifier: findIssue(String(item.id))?.identifier ?? '',
      }),
    onDragOver: ({ over }) =>
      over
        ? t('np.board.announce.over', {
            status: statusName(resolveDropStatus(String(over.id), columns)),
          })
        : undefined,
    onDragEnd: ({ over }) =>
      over
        ? t('np.board.announce.end', {
            status: statusName(resolveDropStatus(String(over.id), columns)),
          })
        : t('np.board.announce.cancel'),
    onDragCancel: () => t('np.board.announce.cancel'),
  };

  function handleDragStart(event: DragStartEvent): void {
    setActive(findIssue(String(event.active.id)) ?? null);
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActive(null);
    const issue = findIssue(String(event.active.id));
    const target = resolveDropStatus(
      event.over ? String(event.over.id) : null,
      columns,
    );
    if (issue && target) move.drop(issue, target);
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={boardCollisionDetection}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: t('np.board.announce.instructions'),
          },
        }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActive(null)}
      >
        <div
          className={cn(
            '-mx-1 flex gap-3 overflow-x-auto px-1 pb-2',
            fill ? 'h-full min-h-0' : 'min-h-96',
          )}
          aria-label={t('np.board.label')}
          role='region'
        >
          {columns.map((column) => (
            <Column
              key={column.statusKey}
              column={column}
              catalog={catalog}
              issueLink={issueLink}
              more={columnMore?.[column.statusKey]}
              fill={fill}
            />
          ))}
        </div>
        <DragOverlay>
          {active ? <BoardCardFace issue={active} dragging /> : null}
        </DragOverlay>
      </DndContext>
      <NpStartDialog
        request={move.startRequest}
        onDecide={move.decide}
        onCancel={move.cancel}
      />
    </>
  );
}
