import { useTranslation } from '@nocobase/i18n/client';
import { useRuntimeTypeCopy } from '@/components/np-runtime-type-copy';
import { NpMultiSelect } from '@/components/np-multi-select';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import {
  AGENT_CAPABILITIES,
  AGENT_COMMANDS,
  type AgentCapability,
  PM_CAPABILITIES,
} from '../agent-capabilities.js';
import {
  BUILTIN_UNSUPPORTED_CAPABILITIES,
  capabilitiesForType,
  type RuntimeType,
} from '../types-runtime-types.js';

export function CapabilityFields({
  value,
  instructions,
  disabled,
  fixed,
  runtimeType = 'computer',
  onChange,
}: {
  value: readonly AgentCapability[];
  instructions: string;
  disabled: boolean;
  /** NP-183 §2.2: a project manager agent always holds `PM_CAPABILITIES`; the area shows them and cannot change. */
  fixed?: boolean;
  /** NP-219 §3.2: a built-in agent cannot hold some capabilities; they stay listed, disabled, with the reason. */
  runtimeType?: RuntimeType;
  onChange: (value: AgentCapability[]) => void;
}) {
  const { t } = useTranslation();
  const typeName = useRuntimeTypeCopy()(runtimeType).name;
  const unsupported = (key: AgentCapability): boolean =>
    runtimeType === 'builtin' && BUILTIN_UNSUPPORTED_CAPABILITIES.includes(key);
  const option = (key: AgentCapability, unavailable = unsupported(key)) => {
    const label = t(`np.capabilities.${key.replaceAll('.', '_')}`);
    if (!unavailable) return { value: key, label };
    const reason = t('np.agentType.capabilityUnavailable', { name: typeName });
    return {
      value: key,
      label: `${label} (${reason})`,
      disabled: true,
      render: (
        <span className='flex min-w-0 flex-col'>
          <span>{label}</span>
          <span className='text-xs text-muted-foreground'>{reason}</span>
        </span>
      ),
    };
  };
  if (fixed) {
    // A built-in project manager holds `PM_CAPABILITIES` without `repo.read` (§3.2 `BUILTIN_PM_CAPABILITIES`).
    const held = capabilitiesForType(PM_CAPABILITIES, runtimeType);
    return (
      <Field>
        <FieldLabel>{t('np.capabilities.title')}</FieldLabel>
        <FieldDescription>{t('np.pmSetup.capabilitiesFixed')}</FieldDescription>
        <NpMultiSelect
          aria-label={t('np.capabilities.title')}
          options={held.map((key) => option(key, false))}
          value={held}
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
        options={AGENT_CAPABILITIES.map((key) => option(key))}
        value={[...value]}
        disabled={disabled}
        onChange={(keys) => onChange(keys as AgentCapability[])}
      />
      <details>
        <summary>{t('np.capabilities.preview')}</summary>
        <p>{t('np.capabilities.previewHint')}</p>
        <pre className='whitespace-pre-wrap'>{instructions}</pre>
        {/* A built-in agent calls tools, not CLI commands; the server lists them in its brief. */}
        {runtimeType === 'computer' ? (
          <pre className='whitespace-pre-wrap'>
            {value
              .flatMap((key) => AGENT_COMMANDS[key])
              .map((command) => `nocoproject ${command}`)
              .join('\n')}
          </pre>
        ) : null}
      </details>
    </Field>
  );
}
