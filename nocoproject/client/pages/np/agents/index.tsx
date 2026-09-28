import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertCircleIcon, BotIcon, PlusIcon } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';

import { NpOnlineState, NpPulse } from '@/components/np-badges';
import { DataTable } from '@/components/data-table';
import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpShortcuts } from '@/components/np-shortcuts';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { NpTag } from '@/components/np-tag';
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

import { isManagerAgent } from '../api-iter4.js';
import { fetchAgents } from '../api.js';
import { isRuntimeOnline, npKeys } from '../constants.js';
import type { AgentListItem, AgentsTopicPayload } from '../types.js';
import { useRealtimeTopic } from '../use-realtime.js';

/** Route `/agents`: the agents that can execute issues, with their runtime's state; a row opens `/agents/:agentId`. */
export default function AgentsPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });

  useRealtimeTopic<AgentsTopicPayload>('np:agents', () => {
    void queryClient.invalidateQueries({ queryKey: npKeys.agents });
    void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
  });

  const columns = useMemo<ColumnDef<AgentListItem, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        enableHiding: false,
        header: t('np.agents.columns.name'),
        cell: ({ row }) => (
          <div className='flex min-w-0 items-center gap-2'>
            <NpActorAvatar type='agent' name={row.original.name} />
            <div className='min-w-0 leading-tight'>
              <div className='flex min-w-0 items-center gap-2'>
                <Link
                  to={encodeURIComponent(row.original.id)}
                  onClick={(event) => event.stopPropagation()}
                  className='block truncate font-medium hover:underline'
                >
                  {row.original.name}
                </Link>
                {isManagerAgent(row.original) ? (
                  <NpTag tone='violet'>{t('np.agentForm.kinds.manager')}</NpTag>
                ) : null}
              </div>
              {row.original.description ? (
                <div className='line-clamp-1 text-xs text-muted-foreground'>
                  {row.original.description}
                </div>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'provider',
        header: t('np.agents.columns.provider'),
        cell: ({ row }) => <NpTag tone='grey'>{row.original.provider}</NpTag>,
      },
      {
        accessorKey: 'model',
        header: t('np.agents.columns.model'),
        cell: ({ row }) =>
          row.original.model ? (
            <span className='font-mono text-xs'>{row.original.model}</span>
          ) : (
            <span className='text-muted-foreground'>
              {t('np.agents.defaultModel')}
            </span>
          ),
      },
      {
        id: 'runtime',
        header: t('np.agents.columns.runtime'),
        cell: ({ row }) => (
          <div className='flex flex-col gap-0.5'>
            <span className='text-sm'>
              {row.original.runtimeName ?? (
                <span className='text-muted-foreground'>—</span>
              )}
            </span>
            <NpOnlineState online={isRuntimeOnline(row.original)} />
          </div>
        ),
      },
      {
        id: 'activeRuns',
        header: t('np.agents.columns.activeRuns'),
        cell: ({ row }) => {
          const count = row.original.activeRunCount ?? 0;
          return (
            <span className='inline-flex items-center gap-1.5 tabular-nums'>
              {count > 0 ? <NpPulse /> : null}
              {count}
              {row.original.maxConcurrentRuns ? (
                <span className='text-muted-foreground'>
                  / {row.original.maxConcurrentRuns}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        accessorKey: 'access',
        header: t('np.agents.columns.access'),
        cell: ({ row }) =>
          row.original.access ? (
            t(`np.agents.access.${row.original.access}`)
          ) : (
            <span className='text-muted-foreground'>—</span>
          ),
      },
    ],
    [t],
  );

  let content: ReactElement;
  if (agents.isError && !agents.data) {
    const forbidden =
      agents.error instanceof ApiClientError && agents.error.status === 403;
    content = (
      <Alert variant='destructive'>
        <AlertCircleIcon />
        <AlertTitle>{t('np.agents.loadFailed')}</AlertTitle>
        <AlertDescription>
          {forbidden ? t('np.common.forbidden') : t('np.common.requestFailed')}
        </AlertDescription>
        {forbidden ? null : (
          <AlertAction>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void agents.refetch()}
            >
              {t('status.retry')}
            </Button>
          </AlertAction>
        )}
      </Alert>
    );
  } else if (!agents.data) {
    content = (
      <div
        role='status'
        aria-label={t('status.loading')}
        className='space-y-2 rounded-lg border p-4'
      >
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-10 w-full' />
        ))}
      </div>
    );
  } else if (agents.data.length === 0) {
    content = (
      <Empty className='border'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>{t('np.agents.emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('np.agents.emptyDescription')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant='outline'
            nativeButton={false}
            render={<Link to='new' />}
          >
            <PlusIcon data-icon='inline-start' />
            {t('np.agents.new')}
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    content = (
      <DataTable
        columns={columns}
        data={agents.data}
        getRowId={(agent) => agent.id}
        pageSize={20}
        showSelectedCount={false}
        onRowClick={(row) => void navigate(encodeURIComponent(row.original.id))}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('np.agents.title')}
        description={t('np.agents.description')}
        actions={
          <Button nativeButton={false} render={<Link to='new' />}>
            <PlusIcon data-icon='inline-start' />
            {t('np.agents.new')}
          </Button>
        }
      />
      <NpShortcuts />
      {content}
      <Outlet />
    </PageContainer>
  );
}
