import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { fetchAgents } from '../api.js';
import { npKeys } from '../constants.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import { ProcessSelect } from '../issues/process-fields.js';
import type { PmSettingsDraft } from './pm-settings-model.js';
export function PmSettingsFields({
  draft,
  canEdit,
  onChange,
}: {
  draft: PmSettingsDraft;
  canEdit: boolean;
  onChange: (value: PmSettingsDraft) => void;
}) {
  const { t } = useTranslation();
  const api = useApiClient();
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  return (
    <>
      <Field>
        <FieldLabel htmlFor='np-entry-process'>
          {t('np.pmSettings.defaultProcess')}
        </FieldLabel>
        <ProcessSelect
          id='np-entry-process'
          value={draft.defaultProcess}
          disabled={!canEdit}
          onChange={(defaultProcess) => onChange({ ...draft, defaultProcess })}
        />
      </Field>
      {(['conversation', 'completion'] as const).map((key) => {
        const entry = draft.agentEntries[key];
        const change = (patch: Partial<typeof entry>) =>
          onChange({
            ...draft,
            agentEntries: {
              ...draft.agentEntries,
              [key]: { ...entry, ...patch },
            },
          });
        return (
          <fieldset key={key} className='space-y-4'>
            <legend>{t(`np.entries.${key}`)}</legend>
            <Field>
              <FieldLabel htmlFor={`np-entry-${key}-enabled`}>
                {t('np.entries.enabled')}
              </FieldLabel>
              <Switch
                id={`np-entry-${key}-enabled`}
                checked={entry.enabled}
                disabled={!canEdit}
                onCheckedChange={(enabled) => change({ enabled })}
              />
            </Field>
            {key === 'conversation' ? (
              <Field orientation='horizontal'>
                <FieldContent>
                  <FieldLabel htmlFor='np-entry-conversation-allow-personal'>
                    {t('np.pmSetup.allowPersonal')}
                  </FieldLabel>
                  <FieldDescription>
                    {t('np.pmSetup.allowPersonalHint')}
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id='np-entry-conversation-allow-personal'
                  checked={
                    draft.agentEntries.conversation.allowPersonal === true
                  }
                  disabled={!canEdit}
                  onCheckedChange={(allowPersonal) => change({ allowPersonal })}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`np-entry-${key}-name`}>
                {t('np.entries.name')}
              </FieldLabel>
              <Input
                id={`np-entry-${key}-name`}
                value={entry.name}
                disabled={!canEdit}
                onChange={(event) => change({ name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`np-entry-${key}-agent`}>
                {t('np.entries.agent')}
              </FieldLabel>
              <PropertySelect
                id={`np-entry-${key}-agent`}
                value={entry.agentId}
                disabled={!canEdit}
                noneLabel={t('np.pmSettings.none')}
                options={(agents.data ?? [])
                  .filter(
                    (agent) =>
                      agent.canInvoke &&
                      !agent.archivedAt &&
                      agent.capabilities?.includes('comment.create'),
                  )
                  .map((agent) => ({ value: agent.id, label: agent.name }))}
                onChange={(agentId) => change({ agentId })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`np-entry-${key}-instructions`}>
                {t('np.entries.instructions')}
              </FieldLabel>
              <Textarea
                id={`np-entry-${key}-instructions`}
                value={entry.instructions}
                disabled={!canEdit}
                onChange={(event) =>
                  change({ instructions: event.target.value })
                }
              />
            </Field>
          </fieldset>
        );
      })}
    </>
  );
}
