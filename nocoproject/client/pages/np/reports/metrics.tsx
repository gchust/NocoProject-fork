import { useApiClient } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router';

import { DateRangePicker } from '@/components/date-picker';
import { NpListSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { Spinner } from '@/components/ui/spinner';

import { fetchMetrics } from '../api-iter3.js';
import { fetchProjects } from '../api.js';
import { npKeys } from '../constants.js';
import {
  failureReasonKey,
  fromDateOnly,
  toDateOnly,
  useDateFnsLocale,
} from '../format.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import type { MetricsQuery, MetricsReport } from '../types-iter3.js';
import { defaultUsageRange, formatCost } from '../usage-model.js';
import { MetricGroupSection } from './metric-group.js';
import { metricGroups, warnCount } from './metrics-model.js';

/**
 * Tab `/reports/metrics` (§C): the six acceptance metric groups for a date range (the last 30 days by default) and an
 * optional project — adoption, AI share, trust, reliability, cost and human load. Thresholded metrics carry a status
 * badge; the breakdowns (failures by reason, cost by agent, decisions by type) are tables. Range and project live in
 * the query string.
 */
export default function MetricsReportTab(): ReactElement {
  const { t } = useTranslation();
  const dateLocale = useDateFnsLocale();
  const api = useApiClient();
  const [params, setParams] = useSearchParams();
  const fallback = defaultUsageRange();
  const query: MetricsQuery = {
    from: params.get('from') ?? fallback.from,
    to: params.get('to') ?? fallback.to,
    projectId: params.get('project') ?? undefined,
  };
  const metrics = useQuery({
    queryKey: npKeys.metrics(query),
    queryFn: ({ signal }) => fetchMetrics(api, query, signal),
    placeholderData: keepPreviousData,
  });
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });

  function update(changes: Record<string, string | null>): void {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    setParams(next, { replace: true });
  }

  let content: ReactElement;
  if (metrics.isError && !metrics.data) {
    content = (
      <NpLoadError
        title={t('np.metrics.loadFailed')}
        error={metrics.error}
        onRetry={() => void metrics.refetch()}
      />
    );
  } else if (!metrics.data) {
    content = <NpListSkeleton rows={6} />;
  } else {
    content = <MetricsBody report={metrics.data} />;
  }

  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-center gap-2'>
        <PropertySelect
          id='np-metrics-project'
          size='default'
          className='w-48'
          aria-label={t('np.filters.project')}
          options={(projects.data ?? []).map((project) => ({
            value: project.id,
            label: project.name,
          }))}
          value={query.projectId ?? null}
          noneLabel={t('np.filters.allProjects')}
          onChange={(value) => update({ project: value })}
        />
        <DateRangePicker
          id='np-metrics-range'
          locale={dateLocale}
          formatString='PP'
          placeholder={t('np.usage.range')}
          value={{ from: fromDateOnly(query.from), to: fromDateOnly(query.to) }}
          onChange={(range) => {
            if (range?.from && range.to) {
              update({
                from: toDateOnly(range.from),
                to: toDateOnly(range.to),
              });
            }
          }}
        />
        {metrics.isFetching && metrics.data ? (
          <Spinner
            className='size-4 text-muted-foreground'
            aria-label={t('status.loading')}
          />
        ) : null}
      </div>
      {content}
    </div>
  );
}

function MetricsBody({
  report,
}: {
  readonly report: MetricsReport;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const groups = metricGroups(report);
  const warnings = warnCount(groups);
  return (
    <div className='space-y-6'>
      <p className='flex flex-wrap items-center gap-2 text-sm text-muted-foreground'>
        {warnings > 0 ? (
          <NpTag tone='red' dot>
            {t('np.metrics.warnSummary', { count: warnings })}
          </NpTag>
        ) : (
          <NpTag tone='green' dot>
            {t('np.metrics.allOk')}
          </NpTag>
        )}
        <span>{t('np.metrics.thresholdHint')}</span>
      </p>
      {groups.map((group) => (
        <MetricGroupSection
          key={group.key}
          group={group}
          breakdown={
            group.key === 'reliability'
              ? {
                  title: t('np.metrics.tables.failures'),
                  keyLabel: t('np.metrics.tables.reason'),
                  valueLabel: t('np.metrics.tables.count'),
                  rows: Object.entries(report.reliability.failuresByReason).map(
                    ([key, count]) => ({
                      key,
                      label: t(failureReasonKey(key), { defaultValue: key }),
                      value: count,
                      display: String(count),
                    }),
                  ),
                }
              : group.key === 'cost'
                ? {
                    title: t('np.metrics.tables.byAgent'),
                    keyLabel: t('np.metrics.tables.agent'),
                    valueLabel: t('np.metrics.tables.cost'),
                    rows: report.cost.byAgent.map((row) => ({
                      key: row.agentId,
                      label: row.name ?? row.agentId,
                      value: row.cost ?? 0,
                      display: formatCost(row.cost, locale),
                    })),
                  }
                : group.key === 'humanLoad'
                  ? {
                      title: t('np.metrics.tables.byType'),
                      keyLabel: t('np.metrics.tables.type'),
                      valueLabel: t('np.metrics.tables.count'),
                      rows: Object.entries(report.humanLoad.byType).map(
                        ([key, count]) => ({
                          key,
                          label: t(`np.inbox.types.${key}`, {
                            defaultValue: key,
                          }),
                          value: count,
                          display: String(count),
                        }),
                      ),
                    }
                  : undefined
          }
        />
      ))}
    </div>
  );
}
