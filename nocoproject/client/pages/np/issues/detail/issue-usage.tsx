import { useApiClient } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';

import { fetchUsage } from '../../api-iter2.js';
import { npKeys } from '../../constants.js';
import { toDateOnly } from '../../format.js';
import type { Issue, UsageQuery, UsageRow } from '../../types.js';
import { formatCost, formatTokens, usageForIssue } from '../../usage-model.js';
import { PropertyRow } from './property-fields.js';

/**
 * "Usage" in the issue's right column (iteration 2 §I): every run of this issue added up. The detail carries it when
 * the server includes it; otherwise the issue-grouped usage from the issue's creation day to today is asked for.
 */
export function IssueUsage({
  issue,
  usage,
}: {
  readonly issue: Issue;
  readonly usage: UsageRow | null;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const [today] = useState(() => toDateOnly(new Date()) ?? '');
  const query: UsageQuery = {
    from: issue.createdAt.slice(0, 10),
    to: today,
    groupBy: 'issue',
    issueId: issue.id,
  };
  const fetched = useQuery({
    queryKey: npKeys.usage(query),
    queryFn: ({ signal }) => fetchUsage(api, query, signal),
    enabled: usage === null,
  });
  const row =
    usage ?? (fetched.data ? usageForIssue(fetched.data.rows, issue.id) : null);

  return (
    <section className='space-y-3' aria-labelledby='np-issue-usage-heading'>
      <h2 id='np-issue-usage-heading' className='text-sm font-semibold'>
        {t('np.usage.issueTitle')}
      </h2>
      {row ? (
        <>
          <PropertyRow label={t('np.usage.columns.runs')}>
            <span className='tabular-nums'>{row.runs}</span>
          </PropertyRow>
          <PropertyRow label={t('np.usage.columns.input')}>
            <span className='tabular-nums'>
              {formatTokens(row.inputTokens, locale)}
            </span>
          </PropertyRow>
          <PropertyRow label={t('np.usage.columns.output')}>
            <span className='tabular-nums'>
              {formatTokens(row.outputTokens, locale)}
            </span>
          </PropertyRow>
          <PropertyRow label={t('np.usage.columns.cache')}>
            <span className='tabular-nums'>
              {formatTokens(row.cacheReadTokens + row.cacheWriteTokens, locale)}
            </span>
          </PropertyRow>
          <PropertyRow label={t('np.usage.columns.cost')}>
            <span className='tabular-nums'>
              {formatCost(row.estimatedCost, locale)}
            </span>
          </PropertyRow>
        </>
      ) : (
        <p className='text-sm text-muted-foreground'>
          {fetched.isPending && usage === null
            ? t('status.loading')
            : t('np.usage.none')}
        </p>
      )}
    </section>
  );
}
