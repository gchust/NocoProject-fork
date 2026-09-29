import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SaveIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { NpDetailSkeleton, NpLoadError } from '@/components/np-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

import { fetchWorkflows } from '../api-collab.js';
import {
  fetchWorkspaceSettings,
  updateWorkspaceSettings,
} from '../api-iter2.js';
import {
  DEFAULT_STATUS_CATALOG,
  npKeys,
  statusLabelKey,
} from '../constants.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import type { IntakeParserSetting, WorkspaceSettings } from '../types.js';
import { ConfigSectionHeading } from './config-section.js';
import { ModelPricesTable } from './model-prices-table.js';
import { PmSettingsFields } from './pm-settings-fields.js';
import { pmSettingsDraft, pmSettingsInput } from './pm-settings-model.js';
import {
  type PriceDraft,
  priceDraft,
  pricesFromDrafts,
} from './model-prices.js';
import { ThresholdFields } from './threshold-fields.js';
import { thresholdDraft, thresholdsFromDraft } from './thresholds-model.js';

/**
 * Tab `/config/general` (iteration 2 §I settings, moved to the front end in iteration 3 §G): the status a merged PR
 * moves its issue to, whether new issues let agents run the sub-issues they create, how batch entry parses text, the
 * model prices usage costs are estimated from, the metric thresholds (§C), and since iteration 4 the default process,
 * the project manager agent and the retrospective switch. Whoever may change the settings item `nocoproject.general`
 * (NP-117; owner/admin by default) edits — the server says so in `canEdit`; everyone else sees the values read-only.
 * The viewer's own inbox chime switch (NP-108) moved to `/profile` in NP-153, since it is a personal preference and
 * not a workspace setting.
 */
export default function GeneralConfigTab(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const settings = useQuery({
    queryKey: npKeys.settings,
    queryFn: () => fetchWorkspaceSettings(api),
    retry: (count, error) =>
      !(error instanceof ApiClientError && error.status === 403) && count < 2,
  });

  let content: ReactElement;
  if (settings.isError && !settings.data) {
    content = (
      <NpLoadError
        title={t('np.settingsPage.loadFailed')}
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  } else if (!settings.data) {
    content = <NpDetailSkeleton />;
  } else {
    content = (
      <SettingsForm
        key={JSON.stringify(settings.data)}
        settings={settings.data}
        canEdit={settings.data.canEdit ?? false}
      />
    );
  }
  return (
    <section className='space-y-4' aria-labelledby='np-config-general-heading'>
      <ConfigSectionHeading
        id='np-config-general-heading'
        title={t('np.settingsPage.title')}
        description={t('np.settingsPage.description')}
      />
      {content}
    </section>
  );
}

function SettingsForm({
  settings,
  canEdit,
}: {
  readonly settings: WorkspaceSettings;
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const workflows = useQuery({
    queryKey: npKeys.workflows,
    queryFn: () => fetchWorkflows(api),
  });
  const [prMergedStatus, setPrMergedStatus] = useState(
    settings.prMergedStatus ?? 'none',
  );
  const [autoExecute, setAutoExecute] = useState(
    settings.autoExecuteSubtasksDefault ?? false,
  );
  const [intakeParser, setIntakeParser] = useState<IntakeParserSetting>(
    settings.intakeParser ?? 'auto',
  );
  const [prices, setPrices] = useState<PriceDraft[]>(() =>
    (settings.modelPrices ?? []).map(priceDraft),
  );
  const [thresholds, setThresholds] = useState(() =>
    thresholdDraft(settings.metricThresholds),
  );
  const [pm, setPm] = useState(() => pmSettingsDraft(settings));
  const modelPrices = pricesFromDrafts(prices);
  const metricThresholds = thresholdsFromDraft(thresholds);

  const defaultWorkflow =
    workflows.data?.find((workflow) => workflow.isDefault) ??
    workflows.data?.[0];
  const statusKeys =
    defaultWorkflow?.definition.statuses.map((status) => status.key) ??
    DEFAULT_STATUS_CATALOG.map((entry) => entry.key);

  const save = useMutation({
    mutationFn: () =>
      updateWorkspaceSettings(api, {
        prMergedStatus,
        autoExecuteSubtasksDefault: autoExecute,
        intakeParser,
        modelPrices: modelPrices ?? [],
        ...(metricThresholds ? { metricThresholds } : {}),
        ...pmSettingsInput(pm),
      }),
    onSuccess: () => {
      toast.add({ type: 'success', title: t('np.settingsPage.saved') });
      void queryClient.invalidateQueries({ queryKey: npKeys.settings });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
      }),
  });

  return (
    <FieldGroup className='max-w-2xl'>
      {canEdit ? null : (
        <Alert>
          <AlertDescription>{t('np.settingsPage.readOnly')}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor='np-settings-pr-status'>
          {t('np.settingsPage.prMergedStatus')}
        </FieldLabel>
        <PropertySelect
          id='np-settings-pr-status'
          size='default'
          disabled={!canEdit}
          options={[
            { value: 'none', label: t('np.settingsPage.prMergedNone') },
            ...statusKeys.map((key) => ({
              value: key,
              label: t(statusLabelKey(key), { defaultValue: key }),
            })),
          ]}
          value={prMergedStatus}
          onChange={(value) => setPrMergedStatus(value ?? 'none')}
        />
        <FieldDescription>
          {t('np.settingsPage.prMergedStatusHint')}
        </FieldDescription>
      </Field>
      <Field orientation='horizontal'>
        <FieldContent>
          <FieldLabel htmlFor='np-settings-auto-execute'>
            {t('np.settingsPage.autoExecute')}
          </FieldLabel>
          <FieldDescription>
            {t('np.settingsPage.autoExecuteHint')}
          </FieldDescription>
        </FieldContent>
        <Switch
          id='np-settings-auto-execute'
          checked={autoExecute}
          disabled={!canEdit}
          onCheckedChange={setAutoExecute}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor='np-settings-intake-parser'>
          {t('np.settingsPage.intakeParser')}
        </FieldLabel>
        <PropertySelect
          id='np-settings-intake-parser'
          size='default'
          disabled={!canEdit}
          options={[
            { value: 'auto', label: t('np.settingsPage.intakeParserAuto') },
            {
              value: 'heuristic',
              label: t('np.settingsPage.intakeParserHeuristic'),
            },
          ]}
          value={intakeParser}
          onChange={(value) =>
            setIntakeParser(value === 'heuristic' ? 'heuristic' : 'auto')
          }
        />
        <FieldDescription>
          {t('np.settingsPage.intakeParserHint')}
        </FieldDescription>
      </Field>
      <PmSettingsFields draft={pm} canEdit={canEdit} onChange={setPm} />
      <ThresholdFields
        draft={thresholds}
        onChange={setThresholds}
        invalid={metricThresholds === null}
        canEdit={canEdit}
      />
      <ModelPricesTable
        prices={prices}
        setPrices={setPrices}
        invalid={modelPrices === null}
        canEdit={canEdit}
      />
      {canEdit ? (
        <div className='flex justify-end'>
          <Button
            disabled={
              save.isPending ||
              modelPrices === null ||
              metricThresholds === null
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <SaveIcon data-icon='inline-start' />
            )}
            {t('actions.save')}
          </Button>
        </div>
      ) : null}
    </FieldGroup>
  );
}
