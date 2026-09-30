import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertCircleIcon, MonitorIcon, PlusIcon } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { Link, Outlet } from 'react-router';

import { GroupedDataTable } from '@/components/data-table-grouped';
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

import { fetchComputers } from '../api-computers.js';
import { fetchRuntimes } from '../api.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { AgentsTopicPayload, Runtime } from '../types.js';
import { useRealtimeTopic } from '../use-realtime.js';
import { ComputerGroupHeader } from './computer-group-header.js';
import { computerKeyOf, groupRuntimesByComputer } from './computer-groups.js';
import { ComputersSection } from './computers-section.js';
import { PmAllowedCell } from './pm-allowed-cell.js';
import { RuntimeCliCell, RuntimeStatusCell } from './runtime-cli.js';

function deviceText(runtime: Runtime, key: string): string | null {
  const value = runtime.deviceInfo?.[key];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Route `/runtimes`: the computers (daemons) that registered coding tools with this application, each computer's
 * runtimes under one group row (NP-188).
 */
export default function RuntimesPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();

  const runtimes = useQuery({
    queryKey: npKeys.runtimes,
    queryFn: () => fetchRuntimes(api),
  });
  // Shared with `ComputersSection` (same key).
  const computers = useQuery({
    queryKey: npKeys.computers,
    queryFn: () => fetchComputers(api),
  });

  useRealtimeTopic<AgentsTopicPayload>('np:agents', () => {
    void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
    void queryClient.invalidateQueries({ queryKey: npKeys.agents });
    void queryClient.invalidateQueries({ queryKey: npKeys.computers });
  });

  const columns = useMemo<ColumnDef<Runtime, unknown>[]>(
    () => [
      {
        accessorKey: 'provider',
        enableHiding: false,
        header: t('np.runtimes.columns.provider'),
        cell: ({ row }) => (
          <span title={row.original.name}>
            <NpTag tone='grey'>{row.original.provider}</NpTag>
          </span>
        ),
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
        accessorKey: 'kind',
        header: t('np.runtimes.columns.kind'),
        cell: ({ row }) =>
          t(`np.runtimes.kind.${row.original.kind}`, {
            defaultValue: row.original.kind,
          }),
      },
      {
        id: 'pmAllowed',
        header: t('np.pmSetup.pmAllowedColumn'),
        cell: ({ row }) => <PmAllowedCell runtime={row.original} />,
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
    ],
    [t, format],
  );

  // NP-188: the runtimes grouped under their computer; the credentials name the computers the viewer added.
  const groups = useMemo(
    () => groupRuntimesByComputer(runtimes.data ?? [], computers.data),
    [runtimes.data, computers.data],
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
      <GroupedDataTable
        columns={columns}
        data={runtimes.data}
        getRowId={(runtime) => runtime.id}
        groupOf={computerKeyOf}
        groups={groups.map((group) => ({
          id: group.id,
          header: (
            <ComputerGroupHeader
              group={group}
              count={t('np.computers.group.runtimes', {
                count: group.runtimes.length,
              })}
              extra={
                <span className='inline-flex items-center gap-1.5 text-xs text-muted-foreground'>
                  {t('np.runtimes.columns.cli')}
                  <RuntimeCliCell runtime={group.runtimes[0]} />
                </span>
              }
            />
          ),
        }))}
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
