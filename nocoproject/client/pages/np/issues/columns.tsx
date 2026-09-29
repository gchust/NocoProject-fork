import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import { Link, useLocation } from 'react-router';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpLabelChip } from '@/components/np-labels';

import { DataTableColumnHeader } from '@/components/data-table-column-header';
import {
  NpExecutor,
  NpPriorityLabel,
  NpStatusBadge,
} from '@/components/np-badges';

import { ISSUE_PRIORITIES } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { IssueListItem } from '../types.js';

/**
 * Column definitions for the issue list. The identifier links to the detail page so rows are keyboard-reachable:
 * beside the list (keeping its query string), or under `detailBase` for a page such as `/my-issues`.
 */
export function useIssueColumns(
  detailBase?: string,
): ColumnDef<IssueListItem, unknown>[] {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const { search } = useLocation();

  return useMemo<ColumnDef<IssueListItem, unknown>[]>(
    () => [
      {
        accessorKey: 'identifier',
        enableHiding: false,
        meta: { className: 'w-24' },
        header: ({ column }) => (
          <DataTableColumnHeader
            column={column}
            title={t('np.issues.columns.identifier')}
          />
        ),
        sortingFn: (a, b) =>
          (a.original.number ?? 0) - (b.original.number ?? 0) ||
          a.original.identifier.localeCompare(b.original.identifier),
        cell: ({ row }) => (
          <Link
            to={
              detailBase
                ? `${detailBase}/${encodeURIComponent(row.original.id)}`
                : { pathname: encodeURIComponent(row.original.id), search }
            }
            onClick={(event) => event.stopPropagation()}
            className='font-mono text-xs text-muted-foreground hover:text-foreground hover:underline'
          >
            {row.original.identifier}
          </Link>
        ),
      },
      {
        accessorKey: 'title',
        enableHiding: false,
        enableSorting: false,
        header: t('np.issues.columns.title'),
        // One line, capped at 30rem, the full title on hover: a long title never stretches the table (§1.5). The
        // column takes the remaining width but may shrink (`max-w-0`), so the table never scrolls sideways for it.
        // On a phone the other columns already overflow the screen, so the title keeps a wider floor and the table
        // scrolls sideways for the rest (NP-144).
        meta: { className: 'w-full max-w-0 min-w-40 max-md:min-w-64' },
        cell: ({ row }) => (
          <div className='flex max-w-[30rem] items-center gap-2'>
            <span className='truncate font-medium' title={row.original.title}>
              {row.original.title}
            </span>
            {row.original.labels && row.original.labels.length > 0 ? (
              <span className='flex shrink-0 gap-1'>
                {row.original.labels.slice(0, 2).map((label) => (
                  <NpLabelChip key={label.id} label={label} />
                ))}
                {row.original.labels.length > 2 ? (
                  <span className='text-xs text-muted-foreground'>
                    +{row.original.labels.length - 2}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: 'statusKey',
        enableSorting: false,
        meta: { className: 'w-28' },
        header: t('np.issues.columns.status'),
        cell: ({ row }) => <NpStatusBadge statusKey={row.original.statusKey} />,
      },
      {
        accessorKey: 'priority',
        enableHiding: false,
        meta: { className: 'w-28' },
        header: ({ column }) => (
          <DataTableColumnHeader
            column={column}
            title={t('np.issues.columns.priority')}
          />
        ),
        sortingFn: (a, b) =>
          ISSUE_PRIORITIES.indexOf(a.original.priority) -
          ISSUE_PRIORITIES.indexOf(b.original.priority),
        cell: ({ row }) => <NpPriorityLabel priority={row.original.priority} />,
      },
      {
        id: 'owner',
        enableSorting: false,
        meta: { className: 'w-40 max-w-40' },
        header: t('np.issues.columns.owner'),
        // A definite width inside the cell lets a long name truncate: `max-w` on a cell of an auto-layout table is ignored.
        cell: ({ row }) => (
          <div className='w-34'>
            {row.original.ownerName ? (
              <NpActorAvatar
                type='user'
                name={row.original.ownerName}
                size='xs'
                showName
                className='text-sm'
              />
            ) : (
              <span className='text-muted-foreground'>—</span>
            )}
          </div>
        ),
      },
      {
        id: 'executor',
        enableSorting: false,
        meta: { className: 'w-48 max-w-48' },
        header: t('np.issues.columns.executor'),
        cell: ({ row }) => (
          <div className='w-42'>
            <NpExecutor
              type={row.original.executorType}
              name={row.original.executorName}
              activeRunCount={row.original.activeRunCount}
            />
          </div>
        ),
      },
      {
        accessorKey: 'updatedAt',
        enableHiding: false,
        meta: { className: 'w-32' },
        header: ({ column }) => (
          <DataTableColumnHeader
            column={column}
            title={t('np.issues.columns.updated')}
          />
        ),
        cell: ({ row }) => (
          <span
            className='text-sm whitespace-nowrap text-muted-foreground'
            title={format.dateTime(row.original.updatedAt)}
          >
            {format.relative(row.original.updatedAt)}
          </span>
        ),
      },
    ],
    [t, format, search, detailBase],
  );
}
