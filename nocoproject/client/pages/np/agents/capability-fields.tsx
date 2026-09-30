import { useTranslation } from '@nocobase/i18n/client';
import { NpMultiSelect } from '@/components/np-multi-select';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import {
  AGENT_CAPABILITIES,
  AGENT_COMMANDS,
  type AgentCapability,
  PM_CAPABILITIES,
} from '../agent-capabilities.js';
export function CapabilityFields({
  value,
  instructions,
  disabled,
  fixed,
  onChange,
}: {
  value: readonly AgentCapability[];
  instructions: string;
  disabled: boolean;
  /** NP-183 §2.2: a project manager agent always holds `PM_CAPABILITIES`; the area shows them and cannot change. */
  fixed?: boolean;
  onChange: (value: AgentCapability[]) => void;
}) {
  const { t } = useTranslation();
  if (fixed) {
    return (
      <Field>
        <FieldLabel>{t('np.capabilities.title')}</FieldLabel>
        <FieldDescription>{t('np.pmSetup.capabilitiesFixed')}</FieldDescription>
        <NpMultiSelect
          aria-label={t('np.capabilities.title')}
          options={PM_CAPABILITIES.map((key) => ({
            value: key,
            label: t(`np.capabilities.${key.replaceAll('.', '_')}`),
          }))}
          value={[...PM_CAPABILITIES]}
          disabled
          onChange={() => undefined}
        />
      </Field>
    );
  }
  return (
    <Field>
      <FieldLabel>{t('np.capabilities.title')}</FieldLabel>
      <FieldDescription>{t('np.capabilities.hint')}</FieldDescription>
      <NpMultiSelect
        aria-label={t('np.capabilities.title')}
        options={AGENT_CAPABILITIES.map((key) => ({
          value: key,
          label: t(`np.capabilities.${key.replaceAll('.', '_')}`),
        }))}
        value={[...value]}
        disabled={disabled}
        onChange={(keys) => onChange(keys as AgentCapability[])}
      />
      <details>
        <summary>{t('np.capabilities.preview')}</summary>
        <p>{t('np.capabilities.previewHint')}</p>
        <pre className='whitespace-pre-wrap'>{instructions}</pre>
        <pre className='whitespace-pre-wrap'>
          {value
            .flatMap((key) => AGENT_COMMANDS[key])
            .map((command) => `nocoproject ${command}`)
            .join('\n')}
        </pre>
      </details>
    </Field>
  );
}
