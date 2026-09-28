import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertCircleIcon, PlusIcon, SparklesIcon } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';

import { DataTable } from '@/components/data-table';
import { NpShortcuts } from '@/components/np-shortcuts';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';

import { fetchSkills } from '../api-agent-extras.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { Skill } from '../types.js';

/**
 * Route `/skills` (iteration 2 §H, "技能"): reusable SKILL.md instructions with supporting files, mounted on agents
 * from the agent page. Every member can read them; a row opens `/skills/:skillId`, "New skill" opens `new`.
 */
export default function SkillsPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const format = useNpFormatters();
  const skills = useQuery({
    queryKey: npKeys.skills,
    queryFn: ({ signal }) => fetchSkills(api, signal),
  });

  const columns = useMemo<ColumnDef<Skill, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        enableHiding: false,
        header: t('np.skills.columns.name'),
        cell: ({ row }) => (
          <div className='min-w-0'>
            <p className='truncate font-medium'>{row.original.name}</p>
            <p className='truncate font-mono text-xs text-muted-foreground'>
              {row.original.slug}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'description',
        header: t('np.skills.columns.description'),
        cell: ({ row }) => (
          <span className='line-clamp-2 text-muted-foreground'>
            {row.original.description || '—'}
          </span>
        ),
      },
      {
        accessorKey: 'fileCount',
        header: t('np.skills.columns.files'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.fileCount ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'agentCount',
        header: t('np.skills.columns.agents'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.agentCount ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'updatedAt',
        header: t('np.skills.columns.updated'),
        cell: ({ row }) => (
          <span className='text-muted-foreground'>
            {format.relative(row.original.updatedAt)}
          </span>
        ),
      },
    ],
    [t, format],
  );

  let content: ReactElement;
  if (skills.isError && !skills.data) {
    content = (
      <Alert variant='destructive'>
        <AlertCircleIcon />
        <AlertTitle>{t('np.skills.loadFailed')}</AlertTitle>
        <AlertDescription>{t('np.common.requestFailed')}</AlertDescription>
        <AlertAction>
          <Button
            variant='outline'
            size='sm'
            onClick={() => void skills.refetch()}
          >
            {t('status.retry')}
          </Button>
        </AlertAction>
      </Alert>
    );
  } else if (!skills.data) {
    content = (
      <div role='status' aria-label={t('status.loading')} className='space-y-2'>
        <Skeleton className='h-10 w-full' />
        <Skeleton className='h-10 w-full' />
      </div>
    );
  } else if (skills.data.length === 0) {
    content = (
      <Empty className='border'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <SparklesIcon />
          </EmptyMedia>
          <EmptyTitle>{t('np.skills.emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('np.skills.emptyDescription')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button nativeButton={false} render={<Link to='new' />}>
            <PlusIcon data-icon='inline-start' />
            {t('np.skills.new')}
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    content = (
      <DataTable
        columns={columns}
        data={skills.data}
        getRowId={(skill) => skill.id}
        pageSize={20}
        showSelectedCount={false}
        onRowClick={(row) => void navigate(encodeURIComponent(row.original.id))}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('np.skills.title')}
        description={t('np.skills.description')}
        actions={
          <Button nativeButton={false} render={<Link to='new' />}>
            <PlusIcon data-icon='inline-start' />
            {t('np.skills.new')}
          </Button>
        }
      />
      <NpShortcuts />
      {content}
      <Outlet />
    </PageContainer>
  );
}
