import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertCircleIcon, MonitorIcon, PlusIcon } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { Link, Outlet } from 'react-router';

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

import { fetchRuntimes } from '../api.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { AgentsTopicPayload, Runtime } from '../types.js';
import { useRealtimeTopic } from '../use-realtime.js';
import { ComputersSection } from './computers-section.js';
import { RuntimeCliCell, RuntimeStatusCell } from './runtime-cli.js';

function deviceText(runtime: Runtime, key: string): string | null {
  const value = runtime.deviceInfo?.[key];
  return typeof value === 'string' && value ? value : null;
}

/** Route `/runtimes`: the computers (daemons) that registered coding tools with this application. */
export default function RuntimesPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();

  const runtimes = useQuery({
    queryKey: npKeys.runtimes,
    queryFn: () => fetchRuntimes(api),
  });

  useRealtimeTopic<AgentsTopicPayload>('np:agents', () => {
    void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
    void queryClient.invalidateQueries({ queryKey: npKeys.agents });
    void queryClient.invalidateQueries({ queryKey: npKeys.computers });
  });

  const columns = useMemo<ColumnDef<Runtime, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        enableHiding: false,
        header: t('np.runtimes.columns.name'),
        cell: ({ row }) => {
          const device =
            deviceText(row.original, 'deviceName') ??
            deviceText(row.original, 'hostname');
          return (
            <div className='min-w-0 leading-tight'>
              <div className='truncate font-medium'>{row.original.name}</div>
              {device && device !== row.original.name ? (
                <div className='truncate text-xs text-muted-foreground'>
                  {device}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'provider',
        header: t('np.runtimes.columns.provider'),
        cell: ({ row }) => <NpTag tone='grey'>{row.original.provider}</NpTag>,
      },
      {
        id: 'version',
        header: t('np.runtimes.columns.version'),
        cell: ({ row }) => {
          const version =
            row.original.version ?? deviceText(row.original, 'version');
          return version ? (
            <span className='font-mono text-xs'>{version}</span>
          ) : (
            <span className='text-muted-foreground'>—</span>
          );
        },
      },
      {
        id: 'cli',
        header: t('np.runtimes.columns.cli'),
        cell: ({ row }) => <RuntimeCliCell runtime={row.original} />,
      },
      {
        accessorKey: 'kind',
        header: t('np.runtimes.columns.kind'),
        cell: ({ row }) =>
          t(`np.runtimes.kind.${row.original.kind}`, {
            defaultValue: row.original.kind,
          }),
      },
      {
        accessorKey: 'status',
        header: t('np.runtimes.columns.status'),
        cell: ({ row }) => <RuntimeStatusCell runtime={row.original} />,
      },
      {
        accessorKey: 'lastSeenAt',
        header: t('np.runtimes.columns.lastSeen'),
        cell: ({ row }) => (
          <span
            className='text-sm whitespace-nowrap text-muted-foreground'
            title={format.dateTime(row.original.lastSeenAt)}
          >
            {format.relative(row.original.lastSeenAt)}
          </span>
        ),
      },
      {
        id: 'owner',
        header: t('np.runtimes.columns.owner'),
        cell: ({ row }) =>
          row.original.ownerName ? (
            <NpActorAvatar
              type='user'
              name={row.original.ownerName}
              size='xs'
              showName
              className='text-sm'
            />
          ) : (
            <span className='text-muted-foreground'>—</span>
          ),
      },
    ],
    [t, format],
  );

  let content: ReactElement;
  if (runtimes.isError && !runtimes.data) {
    const forbidden =
      runtimes.error instanceof ApiClientError && runtimes.error.status === 403;
    content = (
      <Alert variant='destructive'>
        <AlertCircleIcon />
        <AlertTitle>{t('np.runtimes.loadFailed')}</AlertTitle>
        <AlertDescription>
          {forbidden ? t('np.common.forbidden') : t('np.common.requestFailed')}
        </AlertDescription>
        {forbidden ? null : (
          <AlertAction>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void runtimes.refetch()}
            >
              {t('status.retry')}
            </Button>
          </AlertAction>
        )}
      </Alert>
    );
  } else if (!runtimes.data) {
    content = (
      <div
        role='status'
        aria-label={t('status.loading')}
        className='space-y-2 rounded-lg border p-4'
      >
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className='h-10 w-full' />
        ))}
      </div>
    );
  } else if (runtimes.data.length === 0) {
    content = (
      <Empty className='border'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <MonitorIcon />
          </EmptyMedia>
          <EmptyTitle>{t('np.runtimes.emptyTitle')}</EmptyTitle>
          <EmptyDescription>
            {t('np.runtimes.emptyDescription')}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant='outline'
            nativeButton={false}
            render={<Link to='connect' />}
          >
            <PlusIcon data-icon='inline-start' />
            {t('np.runtimes.connect')}
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    content = (
      <DataTable
        columns={columns}
        data={runtimes.data}
        getRowId={(runtime) => runtime.id}
        pageSize={20}
        showSelectedCount={false}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('np.runtimes.title')}
        description={t('np.runtimes.description')}
        actions={
          <Button nativeButton={false} render={<Link to='connect' />}>
            <PlusIcon data-icon='inline-start' />
            {t('np.runtimes.connect')}
          </Button>
        }
      />
      <NpShortcuts />
      {content}
      <ComputersSection />
      <Outlet />
    </PageContainer>
  );
}
