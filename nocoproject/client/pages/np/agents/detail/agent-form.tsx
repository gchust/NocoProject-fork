import { CapabilityFields } from '../capability-fields.js';
import {
  type AgentCapability,
  PM_CAPABILITIES,
} from '../../agent-capabilities.js';
import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';

import { NpMultiSelect } from '@/components/np-multi-select';
import { RuntimeTypeTag } from '@/components/np-runtime-type';
import { useRuntimeTypeCopy } from '@/components/np-runtime-type-copy';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import { agentKind, readReasoningEffort } from '../../api-iter4.js';
import { updateAgent } from '../../api.js';
import { npKeys } from '../../constants.js';
import { PropertySelect } from '../../issues/detail/property-fields.js';
import type {
  AgentAccessLevel,
  AgentListItem,
  Member,
  Runtime,
  UpdateAgentInput,
} from '../../types.js';
import type { AgentKind, ReasoningEffort } from '../../types-iter4.js';
import { runtimeTypeOf } from '../../types-runtime-types.js';
import { AgentKindFields } from '../agent-kind-fields.js';
import { agentTypeErrorMessage } from '../agent-type-errors.js';
import { BuiltinModelField } from '../builtin-model-field.js';
import { SummaryField } from '../summary-field.js';

/** `AGENT_SUMMARY_MAX` of the contract (§7.2), counted in characters like the server does. */
const AGENT_SUMMARY_MAX = 200;

const ACCESS_LEVELS: readonly AgentAccessLevel[] = [
  'ownerOnly',
  'specificUsers',
  'everyone',
];

interface Draft {
  readonly capabilities: readonly AgentCapability[];
  readonly name: string;
  readonly description: string;
  readonly summary: string;
  readonly instructions: string;
  readonly model: string;
  readonly maxConcurrentRuns: string;
  readonly runtimeId: string | null;
  readonly access: AgentAccessLevel;
  readonly accessUserIds: readonly string[];
  readonly delegationTargetIds: readonly string[];
  readonly kind: AgentKind;
  readonly reasoningEffort: ReasoningEffort | null;
}

function draftOf(agent: AgentListItem): Draft {
  return {
    capabilities:
      agentKind(agent) === 'manager'
        ? PM_CAPABILITIES
        : (agent.capabilities ?? []),
    name: agent.name,
    description: agent.description ?? '',
    summary: agent.summary ?? '',
    instructions: agent.instructions ?? '',
    model: agent.model ?? '',
    maxConcurrentRuns: String(agent.maxConcurrentRuns ?? 1),
    runtimeId: agent.runtimeId,
    access: agent.access ?? 'ownerOnly',
    accessUserIds: agent.accessUserIds ?? [],
    delegationTargetIds: (agent.delegationTargets ?? []).map(
      (target) => target.id,
    ),
    kind: agentKind(agent),
    reasoningEffort: readReasoningEffort(agent.reasoningEffort),
  };
}

type FieldName =
  'name' | 'summary' | 'instructions' | 'maxConcurrentRuns' | 'accessUserIds';

/**
 * The agent's settings (§J 5, §H): identity, instructions, model, concurrency, runtime (only runtimes of the same
 * provider, which the server requires), who may invoke it, and which agents it may hand sub-issues to directly —
 * a delegation target's proposals are accepted automatically (§D), and its kind and reasoning effort (iteration 4
 * §C). Read-only for anyone but the agent's owner and owner/admin.
 * NP-219: the type is shown read-only (it never changes) and the fields follow it — runtimes of the same type only, a
 * built-in agent's model from its service's enabled models, no reasoning effort for built-in agents, the capabilities
 * a built-in agent cannot hold disabled with the reason, and no built-in agents as delegation targets (§3.3).
 */
export function AgentForm({
  agent,
  runtimes,
  agents,
  members,
  canEdit,
}: {
  readonly agent: AgentListItem;
  readonly runtimes: readonly Runtime[];
  readonly agents: readonly AgentListItem[];
  readonly members: readonly Member[];
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent));
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string>();
  const set = <Key extends keyof Draft>(key: Key, value: Draft[Key]): void =>
    setDraft((current) => ({ ...current, [key]: value }));
  const runtimeType = runtimeTypeOf(agent);
  const builtin = runtimeType === 'builtin';
  const typeCopy = useRuntimeTypeCopy()(runtimeType);

  const save = useMutation({
    mutationFn: (changes: UpdateAgentInput) =>
      updateAgent(api, agent.id, changes),
    onSuccess: (updated) => {
      toast.add({
        type: 'success',
        title: t('np.agentDetail.saved', { name: updated.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.agents });
    },
    onError: (error: unknown) =>
      setFormError(
        error instanceof ApiClientError && error.status === 403
          ? t('np.common.forbidden')
          : error instanceof ApiClientError &&
              error.code === 'PROVIDER_MISMATCH'
            ? t('np.agentDetail.providerMismatch')
            : error instanceof ApiClientError &&
                error.code === 'INVALID_SUMMARY'
              ? t('np.pmSetup.summaryInvalid', { max: AGENT_SUMMARY_MAX })
              : (agentTypeErrorMessage(t, error, typeCopy) ??
                t('np.common.requestFailed')),
      ),
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const found: Partial<Record<FieldName, string>> = {};
    if (!draft.name.trim()) found.name = t('np.agentForm.nameRequired');
    if ([...draft.summary].length > AGENT_SUMMARY_MAX)
      found.summary = t('np.pmSetup.summaryInvalid', {
        max: AGENT_SUMMARY_MAX,
      });
    if (!draft.instructions.trim())
      found.instructions = t('np.agentForm.instructionsRequired');
    const max = Number(draft.maxConcurrentRuns);
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      found.maxConcurrentRuns = t('np.agentForm.maxInvalid');
    }
    if (draft.access === 'specificUsers' && draft.accessUserIds.length === 0) {
      found.accessUserIds = t('np.agentDetail.accessUsersRequired');
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFormError(undefined);
    save.mutate({
      configurationRevision: agent.configurationRevision,
      capabilities: draft.capabilities,
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      summary: draft.summary.trim() || null,
      instructions: draft.instructions.trim(),
      model: draft.model.trim() || null,
      maxConcurrentRuns: max,
      ...(draft.runtimeId ? { runtimeId: draft.runtimeId } : {}),
      access: draft.access,
      accessUserIds:
        draft.access === 'specificUsers' ? draft.accessUserIds : [],
      delegationTargetIds: draft.delegationTargetIds,
      kind: draft.kind,
      reasoningEffort: builtin ? null : draft.reasoningEffort,
    });
  }

  const disabled = !canEdit || save.isPending;
  // Only runtimes of the agent's own type (and provider, which the server also requires), §3.1 / §3.4.
  const compatible = runtimes.filter(
    (runtime) =>
      runtimeTypeOf(runtime) === runtimeType &&
      runtime.provider === agent.provider,
  );
  const selectedRuntime = compatible.find(
    (runtime) => runtime.id === draft.runtimeId,
  );

  return (
    <form onSubmit={submit} noValidate className='max-w-2xl'>
      <FieldGroup>
        <Field>
          <FieldTitle id='np-agent-edit-type-label'>
            {t('np.runtimeType.label')}
          </FieldTitle>
          <div aria-labelledby='np-agent-edit-type-label' role='group'>
            <RuntimeTypeTag type={runtimeType} />
          </div>
          <FieldDescription>
            {t('np.runtimeType.immutableHint')}
          </FieldDescription>
        </Field>
        <CapabilityFields
          value={draft.capabilities}
          instructions={draft.instructions}
          disabled={disabled}
          fixed={agentKind(agent) === 'manager'}
          runtimeType={runtimeType}
          onChange={(capabilities) => set('capabilities', capabilities)}
        />
        {formError ? (
          <Alert variant='destructive'>
            <AlertCircleIcon />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        {!canEdit ? (
          <Alert>
            <AlertCircleIcon />
            <AlertDescription>{t('np.agentDetail.readOnly')}</AlertDescription>
          </Alert>
        ) : null}
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor='np-agent-edit-name'>
            {t('np.agentForm.name')}
          </FieldLabel>
          <Input
            id='np-agent-edit-name'
            value={draft.name}
            maxLength={100}
            disabled={disabled}
            aria-invalid={errors.name ? true : undefined}
            onChange={(event) => set('name', event.target.value)}
          />
          {errors.name ? <FieldError>{errors.name}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-agent-edit-description'>
            {t('np.agentForm.descriptionLabel')}
          </FieldLabel>
          <Input
            id='np-agent-edit-description'
            value={draft.description}
            maxLength={300}
            disabled={disabled}
            onChange={(event) => set('description', event.target.value)}
          />
        </Field>
        <SummaryField
          id='np-agent-edit-summary'
          value={draft.summary}
          error={errors.summary}
          disabled={disabled}
          onChange={(value) => set('summary', value)}
        />
        <Field data-invalid={errors.instructions ? true : undefined}>
          <FieldLabel htmlFor='np-agent-edit-instructions'>
            {t('np.agentForm.instructions')}
          </FieldLabel>
          <Textarea
            id='np-agent-edit-instructions'
            rows={8}
            value={draft.instructions}
            disabled={disabled}
            placeholder={t('np.agentForm.instructionsPlaceholder')}
            aria-invalid={errors.instructions ? true : undefined}
            onChange={(event) => set('instructions', event.target.value)}
          />
          {errors.instructions ? (
            <FieldError>{errors.instructions}</FieldError>
          ) : null}
        </Field>
        <div className='grid gap-4 sm:grid-cols-2'>
          <Field>
            <FieldLabel htmlFor='np-agent-edit-runtime'>
              {t('np.agentForm.runtime')}
            </FieldLabel>
            <PropertySelect
              id='np-agent-edit-runtime'
              size='default'
              options={compatible.map((runtime) => ({
                value: runtime.id,
                label: `${runtime.name} · ${
                  builtin
                    ? (runtime.llmServiceTitle ?? runtime.llmService)
                    : runtime.provider
                }`,
              }))}
              value={draft.runtimeId}
              disabled={disabled}
              onChange={(value) => {
                set('runtimeId', value);
                // Another model service offers other models; fall back to its default.
                if (builtin) set('model', '');
              }}
            />
            <FieldDescription>
              {builtin
                ? t('np.agentType.sameTypeHint', {
                    runtimeName: typeCopy.runtimeName,
                  })
                : t('np.agentDetail.runtimeHint', { provider: agent.provider })}
            </FieldDescription>
          </Field>
          {builtin ? (
            <BuiltinModelField
              id='np-agent-edit-model'
              runtime={selectedRuntime}
              value={draft.model}
              disabled={disabled}
              onChange={(value) => set('model', value)}
            />
          ) : (
            <Field>
              <FieldLabel htmlFor='np-agent-edit-model'>
                {t('np.agentForm.model')}
              </FieldLabel>
              <Input
                id='np-agent-edit-model'
                value={draft.model}
                disabled={disabled}
                placeholder={t('np.agents.defaultModel')}
                onChange={(event) => set('model', event.target.value)}
              />
            </Field>
          )}
          <Field data-invalid={errors.maxConcurrentRuns ? true : undefined}>
            <FieldLabel htmlFor='np-agent-edit-max'>
              {t('np.agentForm.maxConcurrentRuns')}
            </FieldLabel>
            <Input
              id='np-agent-edit-max'
              inputMode='numeric'
              value={draft.maxConcurrentRuns}
              disabled={disabled}
              aria-invalid={errors.maxConcurrentRuns ? true : undefined}
              onChange={(event) => set('maxConcurrentRuns', event.target.value)}
            />
            {errors.maxConcurrentRuns ? (
              <FieldError>{errors.maxConcurrentRuns}</FieldError>
            ) : null}
          </Field>
        </div>
        {builtin ? null : (
          <AgentKindFields
            idPrefix='np-agent-edit'
            kind={draft.kind}
            reasoningEffort={draft.reasoningEffort}
            disabled={disabled}
            onKindChange={(value) => set('kind', value)}
            onReasoningEffortChange={(value) => set('reasoningEffort', value)}
          />
        )}
        <FieldSet>
          <FieldLegend>{t('np.agentDetail.access')}</FieldLegend>
          <FieldDescription>{t('np.agentDetail.accessHint')}</FieldDescription>
          <RadioGroup
            value={draft.access}
            disabled={disabled}
            onValueChange={(value) => {
              const next = ACCESS_LEVELS.find((level) => level === value);
              if (next) set('access', next);
            }}
          >
            {ACCESS_LEVELS.map((level) => (
              <Field key={level} orientation='horizontal'>
                <RadioGroupItem value={level} id={`np-agent-access-${level}`} />
                <FieldContent>
                  <FieldLabel htmlFor={`np-agent-access-${level}`}>
                    {t(`np.agents.access.${level}`)}
                  </FieldLabel>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
          {draft.access === 'specificUsers' ? (
            <Field data-invalid={errors.accessUserIds ? true : undefined}>
              <FieldLabel htmlFor='np-agent-access-users'>
                {t('np.agentDetail.accessUsers')}
              </FieldLabel>
              <NpMultiSelect
                id='np-agent-access-users'
                options={members.map((member) => ({
                  value: member.userId,
                  label: member.name,
                }))}
                value={draft.accessUserIds}
                disabled={disabled}
                placeholder={t('np.agentDetail.accessUsersPlaceholder')}
                onChange={(value) => set('accessUserIds', value)}
              />
              {errors.accessUserIds ? (
                <FieldError>{errors.accessUserIds}</FieldError>
              ) : null}
            </Field>
          ) : null}
        </FieldSet>
        <Field>
          <FieldLabel htmlFor='np-agent-delegation'>
            {t('np.agentDetail.delegation')}
          </FieldLabel>
          <NpMultiSelect
            id='np-agent-delegation'
            options={agents
              .filter(
                (candidate) =>
                  candidate.id !== agent.id &&
                  agentKind(candidate) !== 'manager' &&
                  // A built-in agent never executes issues, so it is no delegation target (§3.3).
                  runtimeTypeOf(candidate) === 'computer',
              )
              .map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
              }))}
            value={draft.delegationTargetIds}
            disabled={disabled}
            placeholder={t('np.agentDetail.delegationPlaceholder')}
            onChange={(value) => set('delegationTargetIds', value)}
          />
          <FieldDescription>
            {t('np.agentDetail.delegationHint')}
          </FieldDescription>
        </Field>
        {canEdit ? (
          <div className='flex justify-end gap-2'>
            <Button
              type='button'
              variant='outline'
              disabled={save.isPending}
              onClick={() => {
                setDraft(draftOf(agent));
                setErrors({});
                setFormError(undefined);
              }}
            >
              {t('np.common.reset')}
            </Button>
            <Button type='submit' disabled={save.isPending}>
              {save.isPending ? <Spinner data-icon='inline-start' /> : null}
              {save.isPending ? t('np.common.saving') : t('np.common.save')}
            </Button>
          </div>
        ) : null}
      </FieldGroup>
    </form>
  );
}
