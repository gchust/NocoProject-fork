import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useApiClient } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { PlugZapIcon, PlusIcon, ZapIcon } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { Link } from 'react-router';

import { DataTable } from '@/components/data-table';
import { NpOnlineState } from '@/components/np-badges';
import { NpListSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

import { fetchUsage } from '../api-iter2.js';
import {
  BUILTIN_CANDIDATES_KEY,
  fetchBuiltinCandidates,
} from '../api-runtime-types.js';
import { fetchAgents, fetchRuntimes } from '../api.js';
import { settingsCheck } from '../config/config-access.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { Runtime, UsageQuery } from '../types.js';
import { runtimeTypeOf } from '../types-runtime-types.js';
import { formatCost, formatTokens } from '../usage-model.js';
import { BuiltinRuntimeActions } from './builtin-runtime-actions.js';
import { currentMonthRange, usageByRuntime } from './builtin-usage.js';
import { PmAllowedCell } from './pm-allowed-cell.js';
import { RuntimeTypeSection } from './runtime-type-section.js';

/** Online, or offline with the reason in words (§4.2). */
export function BuiltinStatusCell({
  runtime,
}: {
  readonly runtime: Runtime;
}): ReactElement {
  const { t } = useTranslation();
  const online = runtime.status === 'online';
  return (
    <div className='flex flex-col items-start gap-0.5'>
      <NpOnlineState online={online} />
      {!online && runtime.statusReason ? (
        <span className='text-xs text-muted-foreground'>
          {t(`np.builtinRuntimes.reasons.${runtime.statusReason}`)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The built-in runtimes block of `/runtimes` (NP-219 §4, §9.1): one row per model service of the AI plugin in use,
 * with its models, whether personal project managers may use it, its state, the last connection test and this
 * month's usage. Without the AI plugin it says so instead of failing. Enabling, testing, renaming and deleting are
 * for those who hold the general settings' `update`.
 */
export function BuiltinRuntimesSection(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const format = useNpFormatters();
  const canManage = useCan(settingsCheck('general', 'update')).can;

  const runtimes = useQuery({
    queryKey: npKeys.runtimes,
    queryFn: () => fetchRuntimes(api),
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  // Only managers may read the AI plugin's services; the answer also tells whether the plugin is there.
  const candidates = useQuery({
    queryKey: BUILTIN_CANDIDATES_KEY,
    queryFn: () => fetchBuiltinCandidates(api),
    enabled: canManage,
    retry: false,
  });
  const rows = useMemo(
    () =>
      runtimes.data?.filter((runtime) => runtimeTypeOf(runtime) === 'builtin'),
    [runtimes.data],
  );
  const usageQuery: UsageQuery = {
    ...currentMonthRange(),
    groupBy: 'agent',
    runtimeType: 'builtin',
  };
  const usage = useQuery({
    queryKey: npKeys.usage(usageQuery),
    queryFn: ({ signal }) => fetchUsage(api, usageQuery, signal),
    enabled: (rows?.length ?? 0) > 0,
  });
  const usageOf = useMemo(
    () => usageByRuntime(usage.data?.rows ?? [], agents.data ?? []),
    [usage.data, agents.data],
  );

  const providerOf = useMemo(
    () =>
      new Map(
        (candidates.data?.services ?? []).map(
          (service) => [service.llmService, service.provider] as const,
        ),
      ),
    [candidates.data],
  );

  const pluginMissing =
    candidates.data?.plugin === 'missing' ||
    (rows ?? []).some((runtime) => runtime.statusReason === 'plugin_missing');

  const columns = useMemo<ColumnDef<Runtime, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        enableHiding: false,
        header: t('np.builtinRuntimes.columns.name'),
        cell: ({ row }) => (
          <div className='flex min-w-0 items-center gap-2'>
            <span className='truncate font-medium' title={row.original.name}>
              {row.original.name}
            </span>
            {row.original.visibility === 'private' ? (
              <NpTag tone='grey'>
                {t('np.builtinRuntimes.visibility.private')}
              </NpTag>
            ) : null}
          </div>
        ),
      },
      {
        id: 'service',
        header: t('np.builtinRuntimes.columns.service'),
        cell: ({ row }) => {
          const title = row.original.llmServiceTitle ?? row.original.llmService;
          // The runtime row has no provider of its own (§5); the candidates name it for those who may read them.
          const provider = row.original.llmService
            ? providerOf.get(row.original.llmService)
            : undefined;
          return (
            <span className='inline-flex min-w-0 items-center gap-2'>
              <span className='truncate'>{title ?? '—'}</span>
              {provider ? <NpTag tone='grey'>{provider}</NpTag> : null}
            </span>
          );
        },
      },
      {
        id: 'models',
        header: t('np.builtinRuntimes.columns.models'),
        cell: ({ row }) => {
          const models = row.original.enabledModels ?? [];
          return (
            <span
              className='tabular-nums'
              title={models.map((model) => model.label).join(', ')}
            >
              {models.length}
            </span>
          );
        },
      },
      {
        id: 'pmAllowed',
        header: t('np.pmSetup.pmAllowedColumn'),
        cell: ({ row }) => <PmAllowedCell runtime={row.original} />,
      },
      {
        accessorKey: 'status',
        header: t('np.builtinRuntimes.columns.status'),
        cell: ({ row }) => <BuiltinStatusCell runtime={row.original} />,
      },
      {
        accessorKey: 'lastCheckedAt',
        header: t('np.builtinRuntimes.columns.lastChecked'),
        cell: ({ row }) =>
          row.original.lastCheckedAt ? (
            <span
              className='text-sm whitespace-nowrap text-muted-foreground'
              title={format.dateTime(row.original.lastCheckedAt)}
            >
              {format.relative(row.original.lastCheckedAt)}
            </span>
          ) : (
            <span className='text-sm text-muted-foreground'>
              {t('np.builtinRuntimes.notChecked')}
            </span>
          ),
      },
      {
        id: 'usage',
        header: t('np.builtinRuntimes.columns.usage'),
        cell: ({ row }) => {
          const used = usageOf.get(row.original.id);
          return used ? (
            <span className='text-sm whitespace-nowrap tabular-nums'>
              {t('np.builtinRuntimes.usageValue', {
                tokens: formatTokens(used.tokens, locale),
                cost: formatCost(used.cost, locale),
              })}
            </span>
          ) : (
            <span className='text-muted-foreground'>—</span>
          );
        },
      },
      ...(canManage
        ? [
            {
              id: 'actions',
              enableHiding: false,
              header: () => (
                <span className='sr-only'>
                  {t('np.builtinRuntimes.columns.actions')}
                </span>
              ),
              cell: ({ row }) => (
                <BuiltinRuntimeActions
                  runtime={row.original}
                  agents={agents.data ?? []}
                />
              ),
            } satisfies ColumnDef<Runtime, unknown>,
          ]
        : []),
    ],
    [t, format, locale, usageOf, providerOf, canManage, agents.data],
  );

  let content: ReactElement;
  if (runtimes.isError && !runtimes.data) {
    content = (
      <NpLoadError
        title={t('np.runtimes.loadFailed')}
        error={runtimes.error}
        onRetry={() => void runtimes.refetch()}
      />
    );
  } else if (!rows) {
    content = <NpListSkeleton rows={2} />;
  } else if (rows.length === 0 && pluginMissing) {
    content = (
      <Empty className='border'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <PlugZapIcon />
          </EmptyMedia>
          <EmptyTitle>{t('np.builtinRuntimes.pluginMissingTitle')}</EmptyTitle>
          <EmptyDescription>
            {t('np.builtinRuntimes.pluginMissingDescription')}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (rows.length === 0) {
    content = (
      <Empty className='border'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <ZapIcon />
          </EmptyMedia>
          <EmptyTitle>{t('np.builtinRuntimes.emptyTitle')}</EmptyTitle>
          <EmptyDescription>
            {t('np.builtinRuntimes.emptyDescription')}
          </EmptyDescription>
        </EmptyHeader>
        {canManage ? (
          <EmptyContent>
            <Button
              variant='outline'
              nativeButton={false}
              render={<Link to='builtin' />}
            >
              <PlusIcon data-icon='inline-start' />
              {t('np.runtimeAdd.builtin')}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  } else {
    content = (
      <div className='space-y-3'>
        {pluginMissing ? (
          <Alert>
            <PlugZapIcon />
            <AlertTitle>
              {t('np.builtinRuntimes.pluginMissingTitle')}
            </AlertTitle>
            <AlertDescription>
              {t('np.builtinRuntimes.pluginMissingDescription')}
            </AlertDescription>
          </Alert>
        ) : null}
        <DataTable
          columns={columns}
          data={rows}
          pageSize={20}
          showSelectedCount={false}
          getRowId={(runtime) => runtime.id}
        />
      </div>
    );
  }

  return <RuntimeTypeSection type='builtin'>{content}</RuntimeTypeSection>;
}
