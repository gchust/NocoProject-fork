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
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import {
  fetchWorkspaceSettings,
  updateWorkspaceSettings,
} from '../api-iter2.js';
import { npKeys } from '../constants.js';
import type { WorkspaceSettings } from '../types.js';
import {
  MAX_SIGNAL_INSTRUCTION_LENGTH,
  MAX_SIGNAL_MAX_CONSECUTIVE,
  type SignalKindInfo,
} from '../types-signals.js';
import { ConfigSectionHeading } from './config-section.js';
import {
  signalKindsOf,
  signalRuleDrafts,
  placeholdersOf,
  signalRulesInput,
  type SignalRuleDraft,
  validMaxConsecutive,
} from './signal-rules-model.js';

/**
 * The signal rules of one source (protocol.phase2-signals.ts), shown on that source's settings tab — today the GitHub
 * tab: whether a linked pull request whose checks failed, or that conflicts with its base, wakes the issue's executor
 * agent, how many times in a row, and with which instruction. Off until someone turns a rule on. The rules are
 * workspace settings, so whoever may change `nocoproject.general` edits them (`canEdit`); everyone else reads.
 */
export function SignalRulesSection({
  source,
}: {
  readonly source: string;
}): ReactElement | null {
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
    const kinds = signalKindsOf(settings.data, source);
    // An older server lists no kinds: nothing to configure.
    if (kinds.length === 0) return null;
    content = (
      <SignalRulesForm
        key={JSON.stringify(settings.data.signalRules ?? {})}
        settings={settings.data}
        kinds={kinds}
      />
    );
  }
  return (
    <section
      className='space-y-4 pt-4'
      aria-labelledby={`np-signals-${source}-heading`}
    >
      <ConfigSectionHeading
        id={`np-signals-${source}-heading`}
        title={t('np.signals.title')}
        description={t('np.signals.description')}
      />
      {content}
    </section>
  );
}

function SignalRulesForm({
  settings,
  kinds,
}: {
  readonly settings: WorkspaceSettings;
  readonly kinds: readonly SignalKindInfo[];
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const canEdit = settings.canEdit ?? false;
  const [drafts, setDrafts] = useState(() => signalRuleDrafts(settings, kinds));
  const signalRules = signalRulesInput(drafts);

  const save = useMutation({
    mutationFn: () =>
      updateWorkspaceSettings(api, { signalRules: signalRules ?? {} }),
    onSuccess: () => {
      toast.add({ type: 'success', title: t('np.signals.saved') });
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
          <AlertDescription>{t('np.signals.readOnly')}</AlertDescription>
        </Alert>
      )}
      {kinds.map((info) => (
        <SignalRuleFields
          key={info.kind}
          info={info}
          draft={drafts[info.kind]}
          canEdit={canEdit}
          onChange={(draft) =>
            setDrafts((current) => ({ ...current, [info.kind]: draft }))
          }
        />
      ))}
      {canEdit ? (
        <div className='flex justify-end'>
          <Button
            disabled={save.isPending || signalRules === null}
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

function SignalRuleFields({
  info,
  draft,
  canEdit,
  onChange,
}: {
  readonly info: SignalKindInfo;
  readonly draft: SignalRuleDraft;
  readonly canEdit: boolean;
  readonly onChange: (draft: SignalRuleDraft) => void;
}): ReactElement {
  const { t } = useTranslation();
  const id = `np-signal-${info.kind.replace(/[^a-zA-Z0-9]/gu, '-')}`;
  const maxInvalid = !validMaxConsecutive(draft.maxConsecutive);
  return (
    <fieldset className='space-y-4' data-np-signal={info.kind}>
      <Field orientation='horizontal'>
        <FieldContent>
          <FieldLabel htmlFor={`${id}-enabled`}>
            {t(`np.signals.kinds.${info.kind}.label`, {
              defaultValue: info.kind,
            })}
          </FieldLabel>
          <FieldDescription>
            {t(`np.signals.kinds.${info.kind}.hint`, { defaultValue: '' })}
          </FieldDescription>
        </FieldContent>
        <Switch
          id={`${id}-enabled`}
          checked={draft.enabled}
          disabled={!canEdit}
          onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
        />
      </Field>
      {draft.enabled ? (
        <>
          <Field data-invalid={maxInvalid || undefined}>
            <FieldLabel htmlFor={`${id}-max`}>
              {t('np.signals.maxConsecutive')}
            </FieldLabel>
            <Input
              id={`${id}-max`}
              inputMode='numeric'
              className='w-24'
              value={draft.maxConsecutive}
              disabled={!canEdit}
              aria-invalid={maxInvalid || undefined}
              onChange={(event) =>
                onChange({ ...draft, maxConsecutive: event.target.value })
              }
            />
            <FieldDescription>
              {t('np.signals.maxConsecutiveHint')}
            </FieldDescription>
            {maxInvalid ? (
              <FieldError>
                {t('np.signals.maxConsecutiveInvalid', {
                  max: MAX_SIGNAL_MAX_CONSECUTIVE,
                })}
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-instruction`}>
              {t('np.signals.instruction')}
            </FieldLabel>
            <Textarea
              id={`${id}-instruction`}
              rows={4}
              maxLength={MAX_SIGNAL_INSTRUCTION_LENGTH}
              value={draft.instruction}
              placeholder={info.defaultInstruction}
              disabled={!canEdit}
              onChange={(event) =>
                onChange({ ...draft, instruction: event.target.value })
              }
            />
            <FieldDescription>
              {t('np.signals.instructionHint')}{' '}
              {placeholdersOf(info.defaultInstruction).map((name, index) => (
                <span key={name}>
                  {index > 0 ? ' ' : null}
                  <code className='font-mono text-xs'>{`{{${name}}}`}</code>
                </span>
              ))}
            </FieldDescription>
          </Field>
        </>
      ) : null}
    </fieldset>
  );
}
