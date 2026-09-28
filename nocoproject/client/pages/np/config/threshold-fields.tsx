import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';

import { THRESHOLD_FIELDS, type ThresholdDraft } from './thresholds-model.js';

const UNIT: Readonly<Record<keyof ThresholdDraft, string>> = {
  aiShare: '%',
  proposalAcceptRate: '%',
  claimLatencyP50Ms: 'ms',
  lostRuns: '',
  decisionResolveHours: 'h',
};

/** The five metric targets of §C as a grid of number fields, each with its unit. */
export function ThresholdFields({
  draft,
  onChange,
  invalid,
  canEdit,
}: {
  readonly draft: ThresholdDraft;
  readonly onChange: (draft: ThresholdDraft) => void;
  readonly invalid: boolean;
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <section className='space-y-3' aria-labelledby='np-settings-thresholds'>
      <div>
        <h3 id='np-settings-thresholds' className='text-sm font-semibold'>
          {t('np.config.thresholds.title')}
        </h3>
        <p className='text-sm text-muted-foreground'>
          {t('np.config.thresholds.description')}
        </p>
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        {THRESHOLD_FIELDS.map((field) => (
          <Field key={field} data-invalid={invalid ? true : undefined}>
            <FieldLabel htmlFor={`np-threshold-${field}`}>
              {t(`np.config.thresholds.fields.${field}`)}
            </FieldLabel>
            <InputGroup>
              <InputGroupInput
                id={`np-threshold-${field}`}
                inputMode='decimal'
                value={draft[field]}
                readOnly={!canEdit}
                aria-invalid={invalid ? true : undefined}
                className='tabular-nums'
                onChange={(event) =>
                  onChange({ ...draft, [field]: event.target.value })
                }
              />
              {UNIT[field] ? (
                <InputGroupAddon align='inline-end'>
                  <InputGroupText>{UNIT[field]}</InputGroupText>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
          </Field>
        ))}
      </div>
      {invalid ? (
        <FieldDescription className='text-destructive'>
          {t('np.config.thresholds.invalid')}
        </FieldDescription>
      ) : null}
    </section>
  );
}
