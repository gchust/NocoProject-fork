import { useApiClient } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';

import { DateRangePicker } from '@/components/date-picker';
import { NpListSkeleton, NpLoadError } from '@/components/np-states';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { fetchUsage } from '../api-iter2.js';
import { npKeys } from '../constants.js';
import { fromDateOnly, toDateOnly, useDateFnsLocale } from '../format.js';
import type { UsageGroupBy, UsageQuery, UsageRow } from '../types.js';
import {
  USAGE_GROUPS,
  defaultUsageRange,
  formatCost,
  formatTokens,
  readUsageGroup,
  sortUsageRows,
} from '../usage-model.js';

const ROW_LINK: Partial<Record<UsageGroupBy, (key: string) => string>> = {
  agent: (key) => `/agents/${encodeURIComponent(key)}`,
  issue: (key) => `/issues/${encodeURIComponent(key)}`,
  project: (key) => `/projects/${encodeURIComponent(key)}`,
};

/**
 * Tab `/reports/usage` (iteration 2 §I "用量统计", moved under 报表 in iteration 3 §G): tokens and estimated cost of
 * agent runs over a date range (the last 30 days by default), grouped by agent, issue, project, day or model, with a
 * totals row. A cost shows "—" when no model price matches; the totals add only priced rows. Members see the runs of
 * issues they can see; owner/admin see all. Range and grouping live in the query string.
 */
export default function UsageReport(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const dateLocale = useDateFnsLocale();
  const api = useApiClient();
  const [params, setParams] = useSearchParams();
  const fallback = defaultUsageRange();
  const query: UsageQuery = {
    from: params.get('from') ?? fallback.from,
    to: params.get('to') ?? fallback.to,
    groupBy: readUsageGroup(params.get('groupBy')),
  };
  const usage = useQuery({
    queryKey: npKeys.usage(query),
    queryFn: ({ signal }) => fetchUsage(api, query, signal),
    placeholderData: keepPreviousData,
  });

  function update(changes: Record<string, string | null>): void {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    setParams(next, { replace: true });
  }

  const tokens = (value: number): string => formatTokens(value, locale);
  const label = (row: UsageRow): ReactElement | string => {
    const text =
      row.name ?? (query.groupBy === 'day' ? row.key : row.key || '—');
    const link = ROW_LINK[query.groupBy];
    return link && row.key ? (
      <Link to={link(row.key)} className='hover:underline'>
        {text}
      </Link>
    ) : (
      text
    );
  };

  let content: ReactElement;
  if (usage.isError && !usage.data) {
    content = (
      <NpLoadError
        title={t('np.usage.loadFailed')}
        error={usage.error}
        onRetry={() => void usage.refetch()}
      />
    );
  } else if (!usage.data) {
    content = <NpListSkeleton rows={4} />;
  } else {
    const { rows, totals } = usage.data;
    content = (
      <div className='space-y-2'>
        <div className='overflow-hidden rounded-lg border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(`np.usage.groups.${query.groupBy}`)}</TableHead>
                <TableHead className='text-right'>
                  {t('np.usage.columns.runs')}
                </TableHead>
                <TableHead className='text-right'>
                  {t('np.usage.columns.input')}
                </TableHead>
                <TableHead className='text-right'>
                  {t('np.usage.columns.output')}
                </TableHead>
                <TableHead className='text-right'>
                  {t('np.usage.columns.cacheRead')}
                </TableHead>
                <TableHead className='text-right'>
                  {t('np.usage.columns.cacheWrite')}
                </TableHead>
                <TableHead className='text-right'>
                  {t('np.usage.columns.cost')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className='h-20 text-center text-muted-foreground'
                  >
                    {t('np.usage.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                sortUsageRows(rows, query.groupBy).map((row) => (
                  <TableRow key={row.key || 'none'}>
                    <TableCell className='max-w-72 truncate font-medium'>
                      {label(row)}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {row.runs}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {tokens(row.inputTokens)}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {tokens(row.outputTokens)}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {tokens(row.cacheReadTokens)}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {tokens(row.cacheWriteTokens)}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {formatCost(row.estimatedCost, locale)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className='font-semibold'>
                  {t('np.usage.total')}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {totals.runs}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {tokens(totals.inputTokens)}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {tokens(totals.outputTokens)}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {tokens(totals.cacheReadTokens)}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {tokens(totals.cacheWriteTokens)}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {formatCost(totals.estimatedCost, locale)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        {typeof totals.pricedRuns === 'number' &&
        totals.pricedRuns < totals.runs ? (
          <p className='text-xs text-muted-foreground'>
            {t('np.usage.pricedNote', {
              priced: totals.pricedRuns,
              total: totals.runs,
            })}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <Tabs
          value={query.groupBy}
          onValueChange={(value) => update({ groupBy: String(value) })}
        >
          <TabsList variant='line' aria-label={t('np.usage.groupBy')}>
            {USAGE_GROUPS.map((group) => (
              <TabsTrigger key={group} value={group}>
                {t(`np.usage.groups.${group}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className='flex items-center gap-2'>
          {usage.isFetching && usage.data ? (
            <Spinner
              className='size-4 text-muted-foreground'
              aria-label={t('status.loading')}
            />
          ) : null}
          <DateRangePicker
            id='np-usage-range'
            locale={dateLocale}
            formatString='PP'
            placeholder={t('np.usage.range')}
            value={{
              from: fromDateOnly(query.from),
              to: fromDateOnly(query.to),
            }}
            onChange={(range) => {
              if (range?.from && range.to) {
                update({
                  from: toDateOnly(range.from),
                  to: toDateOnly(range.to),
                });
              }
            }}
          />
        </div>
      </div>
      {content}
    </div>
  );
}
