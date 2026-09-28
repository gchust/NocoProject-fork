import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { LockIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpPriorityLabel } from '@/components/np-badges';

import { useNpFormatters } from '../format.js';
import type { ProjectListItem } from '../types.js';
import { progressFromCounts } from './progress.js';
import { ProjectProgressBar, ProjectStatusBadge } from './project-badges.js';

/** Columns of the project list; the name links to the detail page so rows are keyboard-reachable. */
export function useProjectColumns(): ColumnDef<ProjectListItem, unknown>[] {
  const { t } = useTranslation();
  const format = useNpFormatters();
  return useMemo<ColumnDef<ProjectListItem, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('np.projects.columns.name'),
        cell: ({ row }) => (
          <Link
            to={encodeURIComponent(row.original.id)}
            onClick={(event) => event.stopPropagation()}
            className='inline-flex items-center gap-1.5 font-medium hover:underline'
          >
            {row.original.name}
            {row.original.visibility === 'members' ? (
              <LockIcon
                className='size-3.5 text-muted-foreground'
                aria-label={t('np.projects.visibility.members')}
              />
            ) : null}
          </Link>
        ),
      },
      {
        id: 'status',
        header: t('np.projects.columns.status'),
        cell: ({ row }) => <ProjectStatusBadge status={row.original.status} />,
      },
      {
        id: 'priority',
        header: t('np.projects.columns.priority'),
        cell: ({ row }) => (
          <NpPriorityLabel priority={row.original.priority ?? 'none'} />
        ),
      },
      {
        id: 'lead',
        header: t('np.projects.columns.lead'),
        cell: ({ row }) =>
          row.original.leadName ? (
            <NpActorAvatar
              type='user'
              name={row.original.leadName}
              size='xs'
              showName
              className='text-sm'
            />
          ) : (
            <span className='text-muted-foreground'>—</span>
          ),
      },
      {
        id: 'progress',
        header: t('np.projects.columns.progress'),
        cell: ({ row }) => {
          const progress = progressFromCounts(row.original.issueCounts);
          return (
            <ProjectProgressBar
              {...progress}
              label={t('np.projects.progressLabel', {
                done: progress.done,
                total: progress.total,
              })}
            />
          );
        },
      },
      {
        id: 'members',
        header: t('np.projects.columns.members'),
        cell: ({ row }) => (
          <span className='text-sm tabular-nums'>
            {row.original.memberCount ?? '—'}
          </span>
        ),
      },
      {
        id: 'dueDate',
        header: t('np.dates.due'),
        cell: ({ row }) => (
          <span className='text-sm whitespace-nowrap text-muted-foreground'>
            {format.date(row.original.dueDate)}
          </span>
        ),
      },
    ],
    [t, format],
  );
}
