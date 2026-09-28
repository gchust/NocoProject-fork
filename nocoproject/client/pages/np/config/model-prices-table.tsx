import { useTranslation } from '@nocobase/i18n/client';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import type { Dispatch, ReactElement, SetStateAction } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import {
  PRICE_FIELDS,
  type PriceDraft,
  priceDraft,
  priceProblems,
} from './model-prices.js';

/**
 * The model prices usage costs are estimated from (iteration 2 §I), as an editable table. Read-only viewers see the
 * values without the add / remove buttons.
 */
export function ModelPricesTable({
  prices,
  setPrices,
  invalid,
  canEdit,
}: {
  readonly prices: readonly PriceDraft[];
  readonly setPrices: Dispatch<SetStateAction<PriceDraft[]>>;
  readonly invalid: boolean;
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();

  function changePrice(index: number, changes: Partial<PriceDraft>): void {
    setPrices((current) =>
      current.map((row, at) => (at === index ? { ...row, ...changes } : row)),
    );
  }

  return (
    <section className='space-y-2' aria-labelledby='np-settings-prices-heading'>
      <div className='flex items-center justify-between gap-2'>
        <div>
          <h2 id='np-settings-prices-heading' className='text-sm font-semibold'>
            {t('np.settingsPage.modelPrices')}
          </h2>
          <p className='text-sm text-muted-foreground'>
            {t('np.settingsPage.modelPricesHint')}
          </p>
        </div>
        {canEdit ? (
          <Button
            variant='outline'
            size='sm'
            onClick={() => setPrices((current) => [...current, priceDraft()])}
          >
            <PlusIcon data-icon='inline-start' />
            {t('np.settingsPage.addPrice')}
          </Button>
        ) : null}
      </div>
      <div className='overflow-hidden rounded-lg border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t('np.settingsPage.priceColumns.provider')}
              </TableHead>
              <TableHead>{t('np.settingsPage.priceColumns.model')}</TableHead>
              {PRICE_FIELDS.map((field) => (
                <TableHead key={field} className='text-right'>
                  {t(`np.settingsPage.priceColumns.${field}`)}
                </TableHead>
              ))}
              <TableHead>
                <span className='sr-only'>
                  {t('np.intake.columns.actions')}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prices.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className='h-16 text-center text-muted-foreground'
                >
                  {t('np.settingsPage.noPrices')}
                </TableCell>
              </TableRow>
            ) : (
              prices.map((row, index) => {
                const problems = priceProblems(row);
                return (
                  <TableRow
                    key={row.key}
                    data-invalid={problems.length > 0 ? true : undefined}
                  >
                    <TableCell className='min-w-28'>
                      <Input
                        value={row.provider}
                        placeholder='anthropic'
                        aria-label={t('np.settingsPage.priceColumns.provider')}
                        className='h-8'
                        readOnly={!canEdit}
                        onChange={(event) =>
                          changePrice(index, { provider: event.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell className='min-w-36'>
                      <Input
                        value={row.model}
                        placeholder='claude-*'
                        aria-label={t('np.settingsPage.priceColumns.model')}
                        aria-invalid={
                          problems.includes('modelRequired') ? true : undefined
                        }
                        className='h-8 font-mono text-xs'
                        readOnly={!canEdit}
                        onChange={(event) =>
                          changePrice(index, { model: event.target.value })
                        }
                      />
                    </TableCell>
                    {PRICE_FIELDS.map((field) => (
                      <TableCell key={field} className='min-w-24'>
                        <Input
                          value={row[field]}
                          inputMode='decimal'
                          aria-label={t(
                            `np.settingsPage.priceColumns.${field}`,
                          )}
                          aria-invalid={
                            problems.includes('invalidNumber')
                              ? true
                              : undefined
                          }
                          className='h-8 text-right tabular-nums'
                          readOnly={!canEdit}
                          onChange={(event) =>
                            changePrice(index, { [field]: event.target.value })
                          }
                        />
                      </TableCell>
                    ))}
                    <TableCell>
                      <Button
                        variant='ghost'
                        size='icon-sm'
                        disabled={!canEdit}
                        aria-label={t('np.settingsPage.removePrice', {
                          model: row.model || '—',
                        })}
                        onClick={() =>
                          setPrices((current) =>
                            current.filter((_, at) => at !== index),
                          )
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {invalid ? (
        <p className='text-xs text-destructive'>
          {t('np.settingsPage.pricesInvalid')}
        </p>
      ) : null}
    </section>
  );
}
