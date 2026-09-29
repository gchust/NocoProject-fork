import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

import { isManagerAgent } from '../api-iter4.js';
import { fetchAgents } from '../api.js';
import { npKeys } from '../constants.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import { ProcessSelect } from '../issues/process-fields.js';
import type { PmSettingsDraft } from './pm-settings-model.js';

/**
 * Settings → General, iteration 4 (§A, §C): the process a new issue gets when it chooses none, the project manager agent
 * (manager-kind agents only) and whether it writes a retrospective when an agent's issue is done.
 */
export function PmSettingsFields({
  draft,
  canEdit,
  onChange,
}: {
  readonly draft: PmSettingsDraft;
  readonly canEdit: boolean;
  readonly onChange: (draft: PmSettingsDraft) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const managers = (agents.data ?? []).filter(isManagerAgent);
  return (
    <>
      <Field>
        <FieldLabel htmlFor='np-settings-default-process'>
          {t('np.pmSettings.defaultProcess')}
        </FieldLabel>
        <ProcessSelect
          id='np-settings-default-process'
          value={draft.defaultProcess}
          disabled={!canEdit}
          onChange={(defaultProcess) => onChange({ ...draft, defaultProcess })}
        />
        <FieldDescription>
          {t('np.pmSettings.defaultProcessHint')}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor='np-settings-pm-agent'>
          {t('np.pmSettings.agent')}
        </FieldLabel>
        <PropertySelect
          id='np-settings-pm-agent'
          size='default'
          noneLabel={t('np.pmSettings.none')}
          options={managers.map((agent) => ({
            value: agent.id,
            label: agent.name,
          }))}
          value={draft.pmAgentId}
          disabled={!canEdit}
          onChange={(pmAgentId) => onChange({ ...draft, pmAgentId })}
        />
        <FieldDescription>{t('np.pmSettings.agentHint')}</FieldDescription>
      </Field>
      <Field orientation='horizontal'>
        <FieldContent>
          <FieldLabel htmlFor='np-settings-retrospective'>
            {t('np.pmSettings.retrospective')}
          </FieldLabel>
          <FieldDescription>
            {t('np.pmSettings.retrospectiveHint')}
          </FieldDescription>
        </FieldContent>
        <Switch
          id='np-settings-retrospective'
          checked={draft.retrospectiveOnDone}
          disabled={!canEdit}
          onCheckedChange={(retrospectiveOnDone) =>
            onChange({ ...draft, retrospectiveOnDone })
          }
        />
      </Field>
    </>
  );
}
