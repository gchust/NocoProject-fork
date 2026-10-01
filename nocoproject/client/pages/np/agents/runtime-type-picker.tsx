import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { RuntimeTypeIcon } from '@/components/np-runtime-type';
import { useRuntimeTypeCopy } from '@/components/np-runtime-type-copy';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

import { RUNTIME_TYPES, type RuntimeType } from '../types-runtime-types.js';

/**
 * The first step of a new agent (NP-219 §9.1): its type, as two comparison cards side by side — what each type does,
 * cannot do and is good for. A radio group, so arrow keys move between the cards. A type that cannot be chosen yet
 * stays visible, disabled, with the reason.
 */
export function RuntimeTypePicker({
  value,
  unavailable,
  onChange,
}: {
  readonly value: RuntimeType | null;
  /** Types that cannot be chosen now, with the reason shown on the card. */
  readonly unavailable?: Partial<Record<RuntimeType, string>>;
  readonly onChange: (type: RuntimeType) => void;
}): ReactElement {
  const { t } = useTranslation();
  const copyOf = useRuntimeTypeCopy();
  return (
    <FieldSet>
      <FieldLegend>{t('np.runtimeType.compareTitle')}</FieldLegend>
      <RadioGroup
        value={value}
        onValueChange={(next: unknown) => {
          if (next === 'computer' || next === 'builtin') onChange(next);
        }}
        className='grid gap-3 sm:grid-cols-2'
      >
        {RUNTIME_TYPES.map((type) => {
          const copy = copyOf(type);
          const reason = unavailable?.[type];
          const id = `np-agent-type-${type}`;
          return (
            <FieldLabel key={type} htmlFor={id} className='h-full'>
              <Field
                orientation='horizontal'
                data-disabled={reason ? true : undefined}
                className='h-full items-start'
              >
                <FieldContent className='gap-2'>
                  <FieldTitle>
                    <RuntimeTypeIcon
                      type={type}
                      className='size-4 text-muted-foreground'
                    />
                    {copy.name}
                  </FieldTitle>
                  <FieldDescription>{copy.summary}</FieldDescription>
                  <dl
                    className={
                      reason
                        ? 'grid gap-1 text-xs text-muted-foreground'
                        : 'grid gap-1 text-xs'
                    }
                  >
                    <div className='flex gap-1.5'>
                      <dt className='shrink-0 text-muted-foreground'>
                        {t('np.runtimeType.cannotLabel')}
                      </dt>
                      <dd>{copy.cannot}</dd>
                    </div>
                    <div className='flex gap-1.5'>
                      <dt className='shrink-0 text-muted-foreground'>
                        {t('np.runtimeType.fitsLabel')}
                      </dt>
                      <dd>{copy.fits}</dd>
                    </div>
                  </dl>
                  {reason ? (
                    <p
                      id={`${id}-reason`}
                      className='text-xs text-muted-foreground'
                    >
                      {reason}
                    </p>
                  ) : null}
                </FieldContent>
                <RadioGroupItem
                  value={type}
                  id={id}
                  disabled={Boolean(reason)}
                  aria-describedby={reason ? `${id}-reason` : undefined}
                />
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>
      <FieldDescription>{t('np.runtimeType.immutableHint')}</FieldDescription>
    </FieldSet>
  );
}
