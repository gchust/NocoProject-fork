import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { MetricCard } from './metric-card.js';
import type { MetricGroup } from './metrics-model.js';

export interface MetricBreakdown {
  readonly title: string;
  readonly keyLabel: string;
  readonly valueLabel: string;
  readonly rows: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: number;
    readonly display: string;
  }[];
}

/** One metric group: a titled block of StatCards and, for three groups, a breakdown table. */
export function MetricGroupSection({
  group,
  breakdown,
}: {
  readonly group: MetricGroup;
  readonly breakdown?: MetricBreakdown;
}): ReactElement {
  const { t } = useTranslation();
  const headingId = `np-metrics-${group.key}`;
  const rows = [...(breakdown?.rows ?? [])].sort(
    (a, b) => b.value - a.value || a.label.localeCompare(b.label),
  );
  return (
    <section aria-labelledby={headingId} className='space-y-3'>
      <div>
        <h2 id={headingId} className='font-heading text-sm font-semibold'>
          {t(`np.metrics.groups.${group.key}.title`)}
        </h2>
        <p className='text-sm text-muted-foreground'>
          {t(`np.metrics.groups.${group.key}.description`)}
        </p>
      </div>
      <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
        {group.items.map((item) => (
          <MetricCard key={item.key} item={item} />
        ))}
      </div>
      {breakdown ? (
        <Card>
          <CardHeader>
            <CardTitle>{breakdown.title}</CardTitle>
            {rows.length === 0 ? (
              <CardDescription>{t('np.metrics.tables.empty')}</CardDescription>
            ) : null}
          </CardHeader>
          {rows.length > 0 ? (
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{breakdown.keyLabel}</TableHead>
                    <TableHead className='text-right'>
                      {breakdown.valueLabel}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell>{row.label}</TableCell>
                      <TableCell className='text-right tabular-nums'>
                        {row.display}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          ) : null}
        </Card>
      ) : null}
    </section>
  );
}
