import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';

import { RuntimeTypeTag } from '@/components/np-runtime-type';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';

import { fetchAgents } from '../np/api.js';
import { readReasoningEffort } from '../np/api-iter4.js';
import {
  copyPmAgentFromDefault,
  fetchPmAgentChoice,
  ineligibleReasonOfError,
  savePmAgentChoice,
} from '../np/api-pm.js';
import { npKeys } from '../np/constants.js';
import { PropertySelect } from '../np/issues/detail/property-fields.js';
import { REASONING_EFFORTS } from '../np/types-iter4.js';
import type { PmAgentChoice } from '../np/types-pm.js';
import { runtimeTypeOf } from '../np/types-runtime-types.js';

/** The radio value of "System default"; agent ids are numeric strings, so it cannot clash. */
const SYSTEM = 'system';

/** The words for a refused choice: the reason of `PM_AGENT_NOT_ELIGIBLE`, or the general failure. */
function failureTitle(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return t('np.common.forbidden');
    if (error.code === 'PM_AGENT_NOT_ELIGIBLE') {
      const reason = ineligibleReasonOfError(error.payload);
      if (reason) return t(`np.pmSetup.notEligible.${reason}`);
    }
    if (error.code === 'PM_NOT_CONFIGURED')
      return t('np.pmSetup.notConfigured');
  }
  return t('np.common.requestFailed');
}

/**
 * "My project manager" on `/profile` (NP-183 §6.2): use the system default or one of the member's own project
 * manager agents for new conversations, or copy the default onto one of their runtimes. The personal choice is
 * hidden while the workspace does not allow it (`allowPersonal`). The server decides eligibility; its reason is
 * shown in words.
 */
export function PmAgentSection(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const choice = useQuery({
    queryKey: npKeys.pmAgentChoice,
    queryFn: ({ signal }) => fetchPmAgentChoice(api, signal),
    retry: false,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('np.pmSetup.title')}</CardTitle>
        <CardDescription>{t('np.pmSetup.dataNote')}</CardDescription>
      </CardHeader>
      <CardContent>
        {choice.isPending ? (
          <Skeleton
            className='h-24 max-w-2xl'
            role='status'
            aria-label={t('status.loading')}
          />
        ) : choice.isError ? (
          <Alert variant='destructive'>
            <AlertDescription>{t('np.pmSetup.loadFailed')}</AlertDescription>
            <Button variant='outline' onClick={() => void choice.refetch()}>
              {t('status.retry')}
            </Button>
          </Alert>
        ) : (
          <PmAgentForm
            key={`${choice.data.revision}:${choice.data.mode}:${choice.data.agentId}`}
            choice={choice.data}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PmAgentForm({
  choice,
}: {
  readonly choice: PmAgentChoice;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const initial =
    choice.allowPersonal && choice.mode === 'personal' && choice.agentId
      ? choice.agentId
      : SYSTEM;
  const [selected, setSelected] = useState(initial);
  // The choice carries no agent type; the agents list does (NP-219).
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const typeOf = (agentId: string) =>
    runtimeTypeOf(agents.data?.find((agent) => agent.id === agentId) ?? {});
  const [refusal, setRefusal] = useState<string>();

  const fail = (error: unknown): void => {
    const title = failureTitle(error, t);
    setRefusal(title);
    toast.add({ type: 'error', priority: 'high', title });
    // A stale revision or a changed workspace switch: show what the server holds now.
    void queryClient.invalidateQueries({ queryKey: npKeys.pmAgentChoice });
  };

  const save = useMutation({
    mutationFn: () =>
      savePmAgentChoice(
        api,
        selected === SYSTEM
          ? { revision: choice.revision, mode: 'system' }
          : { revision: choice.revision, mode: 'personal', agentId: selected },
      ),
    onSuccess: (updated) => {
      setRefusal(undefined);
      queryClient.setQueryData(npKeys.pmAgentChoice, updated);
      toast.add({ type: 'success', title: t('np.pmSetup.saved') });
    },
    onError: fail,
  });

  return (
    <FieldGroup className='max-w-2xl'>
      <FieldSet>
        <FieldLegend variant='label'>
          {t('np.pmSetup.chooseLegend')}
        </FieldLegend>
        <RadioGroup
          value={selected}
          disabled={save.isPending}
          onValueChange={(value) => {
            setRefusal(undefined);
            setSelected(String(value));
          }}
        >
          <Field orientation='horizontal'>
            <RadioGroupItem value={SYSTEM} id='np-pm-choice-system' />
            <FieldContent>
              <FieldLabel htmlFor='np-pm-choice-system'>
                {t('np.pmSetup.systemDefault')}
              </FieldLabel>
              <FieldDescription className='flex flex-wrap items-center gap-1.5'>
                {choice.systemAgent ? (
                  <RuntimeTypeTag type={typeOf(choice.systemAgent.id)} />
                ) : null}
                {choice.systemAgent
                  ? t('np.pmSetup.systemDefaultAgent', {
                      name: choice.systemAgent.name,
                      state: choice.systemAgent.online
                        ? t('np.pmSetup.online')
                        : t('np.pmSetup.offline'),
                    })
                  : t('np.pmSetup.systemDefaultMissing')}
              </FieldDescription>
            </FieldContent>
          </Field>
          {choice.allowPersonal
            ? choice.candidates.map((candidate) => (
                <Field key={candidate.id} orientation='horizontal'>
                  <RadioGroupItem
                    value={candidate.id}
                    id={`np-pm-choice-${candidate.id}`}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={`np-pm-choice-${candidate.id}`}>
                      {candidate.name}
                    </FieldLabel>
                    <FieldDescription className='flex flex-wrap items-center gap-1.5'>
                      <RuntimeTypeTag type={typeOf(candidate.id)} />
                      {[
                        candidate.provider,
                        candidate.model,
                        candidate.runtimeName,
                        candidate.online
                          ? t('np.pmSetup.online')
                          : t('np.pmSetup.offline'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              ))
            : null}
        </RadioGroup>
        {choice.allowPersonal && choice.candidates.length === 0 ? (
          <FieldDescription>{t('np.pmSetup.noCandidates')}</FieldDescription>
        ) : null}
        {!choice.allowPersonal ? (
          <FieldDescription>{t('np.pmSetup.personalOff')}</FieldDescription>
        ) : null}
        {refusal ? (
          <Alert variant='destructive'>
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        ) : null}
        <div>
          <Button
            type='button'
            disabled={save.isPending || selected === initial}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? t('np.common.saving')
              : t('np.pmSetup.saveChoice')}
          </Button>
        </div>
      </FieldSet>
      {choice.allowPersonal && choice.systemAgent ? (
        <CopyFromDefault choice={choice} onRefused={setRefusal} />
      ) : null}
    </FieldGroup>
  );
}

function CopyFromDefault({
  choice,
  onRefused,
}: {
  readonly choice: PmAgentChoice;
  readonly onRefused: (title: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<string | null>(null);
  const copy = useMutation({
    mutationFn: () =>
      copyPmAgentFromDefault(api, {
        runtimeId: runtimeId ?? '',
        model: model.trim() || null,
        reasoningEffort: readReasoningEffort(effort),
      }),
    onSuccess: ({ agent, choice: updated }) => {
      queryClient.setQueryData(npKeys.pmAgentChoice, updated);
      void queryClient.invalidateQueries({ queryKey: npKeys.agents });
      toast.add({
        type: 'success',
        title: t('np.pmSetup.copied', { name: agent.name }),
      });
    },
    onError: (error: unknown) => {
      const title = failureTitle(error, t);
      onRefused(title);
      toast.add({ type: 'error', priority: 'high', title });
    },
  });
  return (
    <FieldSet>
      <FieldLegend variant='label'>{t('np.pmSetup.copyTitle')}</FieldLegend>
      <FieldDescription>{t('np.pmSetup.copyHint')}</FieldDescription>
      {choice.eligibleRuntimes.length === 0 ? (
        <FieldDescription>{t('np.pmSetup.noRuntimes')}</FieldDescription>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor='np-pm-copy-runtime'>
              {t('np.pmSetup.copyRuntime')}
            </FieldLabel>
            <PropertySelect
              id='np-pm-copy-runtime'
              size='default'
              options={choice.eligibleRuntimes.map((runtime) => ({
                value: runtime.id,
                label: [
                  runtime.name,
                  runtime.shared ? t('np.pmSetup.sharedRuntime') : null,
                  runtime.online ? null : t('np.pmSetup.offline'),
                ]
                  .filter(Boolean)
                  .join(' · '),
              }))}
              value={runtimeId}
              onChange={setRuntimeId}
            />
          </Field>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Field>
              <FieldLabel htmlFor='np-pm-copy-model'>
                {t('np.agentForm.model')}
              </FieldLabel>
              <Input
                id='np-pm-copy-model'
                value={model}
                placeholder={t('np.agents.defaultModel')}
                onChange={(event) => setModel(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor='np-pm-copy-effort'>
                {t('np.agentForm.reasoningEffort')}
              </FieldLabel>
              <PropertySelect
                id='np-pm-copy-effort'
                size='default'
                noneLabel={t('np.agentForm.reasoningDefault')}
                options={REASONING_EFFORTS.map((value) => ({
                  value,
                  label: t(`np.agentForm.efforts.${value}`),
                }))}
                value={effort}
                onChange={setEffort}
              />
            </Field>
          </div>
          <div>
            <Button
              type='button'
              variant='outline'
              disabled={!runtimeId || copy.isPending}
              onClick={() => copy.mutate()}
            >
              {t('np.pmSetup.copyAction')}
            </Button>
          </div>
        </>
      )}
    </FieldSet>
  );
}
