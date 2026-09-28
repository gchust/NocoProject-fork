import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { CircleAlertIcon, CircleCheckIcon, InfoIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpTag } from '@/components/np-tag';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import type { MetricStatus } from '../types-iter3.js';
import { formatMetric, type MetricItem } from './metrics-model.js';

/** A metric's threshold status as a badge (§C): on target, off target, or not measurable yet. */
export function MetricStatusBadge({
  status,
}: {
  readonly status: MetricStatus;
}): ReactElement {
  const { t } = useTranslation();
  if (status === 'ok') {
    return (
      <NpTag
        tone='green'
        data-status='ok'
        icon={<CircleCheckIcon aria-hidden='true' />}
      >
        {t('np.metrics.status.ok')}
      </NpTag>
    );
  }
  if (status === 'warn') {
    return (
      <NpTag
        tone='red'
        data-status='warn'
        icon={<CircleAlertIcon aria-hidden='true' />}
      >
        {t('np.metrics.status.warn')}
      </NpTag>
    );
  }
  return (
    <NpTag tone='grey' data-status='n/a'>
      {t('np.metrics.status.na')}
    </NpTag>
  );
}

/**
 * One metric as a StatCard (the dashboard example's card): label, value, and — for a thresholded metric — the target
 * and a status badge. The server's calculation note, when sent, sits behind an info tooltip.
 */
export function MetricCard({
  item,
}: {
  readonly item: MetricItem;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const label = t(`np.metrics.items.${item.key}`);
  return (
    <Card data-metric={item.key}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className='font-heading text-2xl tabular-nums'>
          {formatMetric(item.kind, item.value, locale)}
        </CardTitle>
        {item.definition ? (
          <CardAction>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type='button'
                    className='text-muted-foreground hover:text-foreground'
                    aria-label={t('np.metrics.definition', { name: label })}
                  />
                }
              >
                <InfoIcon className='size-4' />
              </TooltipTrigger>
              <TooltipContent className='max-w-64'>
                {item.definition}
              </TooltipContent>
            </Tooltip>
          </CardAction>
        ) : null}
      </CardHeader>
      {item.threshold ? (
        <CardContent className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          <MetricStatusBadge status={item.status} />
          <span>
            {t(
              item.threshold.rule === 'min'
                ? 'np.metrics.target.min'
                : 'np.metrics.target.max',
              {
                value: formatMetric(item.kind, item.threshold.value, locale),
              },
            )}
          </span>
        </CardContent>
      ) : null}
    </Card>
  );
}
