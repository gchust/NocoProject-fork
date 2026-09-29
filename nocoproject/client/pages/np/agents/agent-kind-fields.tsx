import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { Field, FieldLabel } from '@/components/ui/field';

import { readReasoningEffort } from '../api-iter4.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import {
  type AgentKind,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../types-iter4.js';

/**
 * An agent's kind (Coding / Project manager) and reasoning effort (iteration 4 §C), shared by the create dialog and the settings
 * form. An empty effort is the tool's default; the daemon maps a set one to the tool's own flag.
 */
export function AgentKindFields({
  idPrefix,
  reasoningEffort,
  disabled,
  onReasoningEffortChange,
}: {
  readonly idPrefix: string;
  readonly kind: AgentKind;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly disabled?: boolean;
  readonly onKindChange: (kind: AgentKind) => void;
  readonly onReasoningEffortChange: (effort: ReasoningEffort | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className='grid gap-4 sm:grid-cols-2'>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-effort`}>
          {t('np.agentForm.reasoningEffort')}
        </FieldLabel>
        <PropertySelect
          id={`${idPrefix}-effort`}
          size='default'
          noneLabel={t('np.agentForm.reasoningDefault')}
          options={REASONING_EFFORTS.map((value) => ({
            value,
            label: t(`np.agentForm.efforts.${value}`),
          }))}
          value={reasoningEffort}
          disabled={disabled}
          onChange={(value) =>
            onReasoningEffortChange(readReasoningEffort(value))
          }
        />
      </Field>
    </div>
  );
}
