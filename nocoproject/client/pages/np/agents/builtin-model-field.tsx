import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { Field, FieldError, FieldLabel } from '@/components/ui/field';

import { PropertySelect } from '../issues/detail/property-fields.js';
import type { Runtime } from '../types.js';

/**
 * A built-in agent's model (NP-219 §3.1): one of the enabled models of its runtime's model service, or none for the
 * service's first enabled model. A stored model the service no longer offers stays shown, so it is not lost silently.
 */
export function BuiltinModelField({
  id,
  runtime,
  value,
  error,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly runtime: Runtime | undefined;
  readonly value: string;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly onChange: (model: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const models = runtime?.enabledModels ?? [];
  const first = models[0];
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{t('np.agentForm.model')}</FieldLabel>
      <PropertySelect
        id={id}
        size='default'
        noneLabel={
          first
            ? t('np.agentType.modelDefaultNamed', { model: first.label })
            : t('np.agentType.modelDefault')
        }
        options={models.map((model) => ({
          value: model.value,
          label: model.label,
        }))}
        value={value || null}
        disabled={disabled || !runtime}
        onChange={(next) => onChange(next ?? '')}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
