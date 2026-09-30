import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * "Good at" (NP-183 §7.2, `agents.summary`): one line the project manager reads when it picks an agent for a task.
 * The 200-character limit is the server's (`INVALID_SUMMARY`); the field counts characters the same way.
 */
export function SummaryField({
  id,
  value,
  error,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{t('np.pmSetup.summary')}</FieldLabel>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={t('np.pmSetup.summaryPlaceholder')}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <FieldDescription>{t('np.pmSetup.summaryHint')}</FieldDescription>
      )}
    </Field>
  );
}
