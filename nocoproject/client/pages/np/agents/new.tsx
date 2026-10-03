import { CapabilityFields } from './capability-fields.js';
import type { AgentCapability } from '../agent-capabilities.js';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { NpOnlineState } from '@/components/np-badges';
import { useRuntimeTypeCopy } from '@/components/np-runtime-type-copy';
import { RouteDialog } from '@/components/route-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { UnsavedChangesBoundary } from '@/components/unsaved-changes';
import {
  useUnsavedChanges,
  useUnsavedChangesGuard,
} from '@/components/use-unsaved-changes';
import { useRouteOverlay } from '@/components/use-route-overlay';

import { createAgent, fetchRuntimes } from '../api.js';
import { settingsCheck } from '../config/config-access.js';
import { npKeys } from '../constants.js';
import type { AgentKind, ReasoningEffort } from '../types-iter4.js';
import {
  BUILTIN_PROVIDER,
  capabilitiesForType,
  readRuntimeType,
  runtimeTypeOf,
  type RuntimeType,
} from '../types-runtime-types.js';
import { AgentKindFields } from './agent-kind-fields.js';
import { agentTypeErrorMessage } from './agent-type-errors.js';
import { BuiltinModelField } from './builtin-model-field.js';
import { RuntimeTypePicker } from './runtime-type-picker.js';
import { SummaryField } from './summary-field.js';

const FORM_ID = 'np-agent-new-form';
const DEFAULT_MAX_CONCURRENT_RUNS = 6;
const DEFAULT_CAPABILITIES: readonly AgentCapability[] = [
  'context.read',
  'comment.create',
];

type FieldName =
  'name' | 'summary' | 'instructions' | 'runtimeId' | 'maxConcurrentRuns';

/**
 * Route `/agents/new`: create an agent bound to one runtime, of a kind (iteration 4 §C: Coding / Project manager).
 * NP-219: the type (computer / built-in) comes first, beside the comparison cards; the other fields appear once it is
 * chosen and follow it — only runtimes of that type, a built-in agent's models from its model service, no reasoning
 * effort for built-in agents, and the capabilities it cannot hold disabled with the reason. `?runtimeType=` preselects.
 */
export default function NewAgentPage(): ReactElement {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const unsaved = useUnsavedChangesGuard();
  const handleSubmittingChange = (value: boolean): void => {
    submittingRef.current = value;
    setSubmitting(value);
  };

  return (
    <RouteDialog
      title={t('np.agentForm.title')}
      description={t('np.agentForm.description')}
      className='sm:max-w-xl'
      beforeClose={() => !submittingRef.current && unsaved.confirmDiscard()}
      footer={<NewAgentFooter submitting={submitting} />}
    >
      <UnsavedChangesBoundary guard={unsaved}>
        <NewAgentBody onSubmittingChange={handleSubmittingChange} />
      </UnsavedChangesBoundary>
    </RouteDialog>
  );
}

function NewAgentBody({
  onSubmittingChange,
}: {
  readonly onSubmittingChange: (submitting: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { close } = useRouteOverlay();

  const runtimes = useQuery({
    queryKey: npKeys.runtimes,
    queryFn: () => fetchRuntimes(api),
  });
  const copyOf = useRuntimeTypeCopy();
  const canUseService = useCan(settingsCheck('general', 'update')).can;
  const [searchParams] = useSearchParams();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [summary, setSummary] = useState('');
  const [instructions, setInstructions] = useState('');
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([
    ...DEFAULT_CAPABILITIES,
  ]);
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(
    String(DEFAULT_MAX_CONCURRENT_RUNS),
  );
  // `?kind=manager` (the project manager settings link) preselects the kind; it is where the form starts, not an edit.
  const [initialKind] = useState<AgentKind>(
    searchParams.get('kind') === 'manager' ? 'manager' : 'coder',
  );
  const [initialType] = useState(() =>
    readRuntimeType(searchParams.get('runtimeType')),
  );
  const [runtimeType, setRuntimeType] = useState<RuntimeType | null>(
    initialType,
  );
  const [kind, setKind] = useState<AgentKind>(initialKind);
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string>();
  const markSaved = useUnsavedChanges(
    [name, description, summary, instructions, model].some((value) =>
      value.trim(),
    ) ||
      capabilities.length !== DEFAULT_CAPABILITIES.length ||
      capabilities.some((item) => !DEFAULT_CAPABILITIES.includes(item)) ||
      runtimeId !== null ||
      maxConcurrentRuns !== String(DEFAULT_MAX_CONCURRENT_RUNS) ||
      kind !== initialKind ||
      reasoningEffort !== null ||
      runtimeType !== initialType,
  );

  // A type without any runtime cannot be chosen yet; the computer type stays open, as before, with its "connect" hint.
  const builtinRuntimes = (runtimes.data ?? []).filter(
    (item) => runtimeTypeOf(item) === 'builtin',
  );
  const unavailable =
    runtimes.data && builtinRuntimes.length === 0
      ? {
          builtin: t('np.agentType.unavailableNoRuntime', {
            runtimeName: copyOf('builtin').runtimeName,
          }),
        }
      : undefined;
  const typed = runtimeType ?? 'computer';
  const sameType = (runtimes.data ?? []).filter(
    (item) => runtimeTypeOf(item) === typed,
  );
  const runtime = sameType.find((item) => item.id === runtimeId);
  const runtimeItems = sameType.map((item) => ({
    value: item.id,
    label: `${item.name} · ${
      typed === 'builtin'
        ? (item.llmServiceTitle ?? item.llmService)
        : item.provider
    }`,
  }));

  function chooseType(next: RuntimeType): void {
    if (next === runtimeType) return;
    setRuntimeType(next);
    setRuntimeId(null);
    setModel('');
    setCapabilities((current) => capabilitiesForType(current, next));
    if (next === 'builtin') setReasoningEffort(null);
    setErrors({});
    setFormError(undefined);
  }

  function validate(): Partial<Record<FieldName, string>> {
    const next: Partial<Record<FieldName, string>> = {};
    if (!name.trim()) next.name = t('np.agentForm.nameRequired');
    if ([...summary].length > 200) {
      next.summary = t('np.pmSetup.summaryInvalid', { max: 200 });
    }
    if (!instructions.trim()) {
      next.instructions = t('np.agentForm.instructionsRequired');
    }
    if (!runtimeId) next.runtimeId = t('np.agentForm.runtimeRequired');
    const max = Number(maxConcurrentRuns);
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      next.maxConcurrentRuns = t('np.agentForm.maxInvalid');
    }
    return next;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!runtimeType) {
      setFormError(t('np.agentType.errors.INVALID_RUNTIME_TYPE'));
      return;
    }
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0 || !runtime || !runtimeType) return;
    setFormError(undefined);
    onSubmittingChange(true);
    try {
      const agent = await createAgent(api, {
        name: name.trim(),
        description: description.trim() || undefined,
        summary: summary.trim() || undefined,
        instructions: instructions.trim(),
        capabilities,
        runtimeId: runtime.id,
        provider:
          runtimeType === 'builtin' ? BUILTIN_PROVIDER : runtime.provider,
        model: model.trim() || undefined,
        maxConcurrentRuns: Number(maxConcurrentRuns),
        kind,
        reasoningEffort: runtimeType === 'builtin' ? null : reasoningEffort,
        runtimeType,
      });
      onSubmittingChange(false);
      toast.add({
        type: 'success',
        title: t('np.agentForm.created', { name: agent.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.agents });
      markSaved();
      void close();
    } catch (error: unknown) {
      onSubmittingChange(false);
      setFormError(
        error instanceof ApiClientError && error.status === 403
          ? t('np.common.forbidden')
          : (agentTypeErrorMessage(t, error, copyOf(runtimeType)) ??
              t('np.common.requestFailed')),
      );
    }
  }

  return (
    <form id={FORM_ID} onSubmit={(event) => void submit(event)} noValidate>
      <FieldGroup>
        {formError ? (
          <Alert variant='destructive'>
            <AlertCircleIcon />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <RuntimeTypePicker
          value={runtimeType}
          unavailable={unavailable}
          onChange={chooseType}
        />
        {runtimeType ? (
          renderFields(runtimeType)
        ) : (
          <FieldDescription>{t('np.agentType.choose')}</FieldDescription>
        )}
      </FieldGroup>
    </form>
  );

  // The fields after the type: a plain function over the form state above (not a component, so the inputs are not
  // remounted on every keystroke), split out only to keep the JSX readable.
  function renderFields(type: RuntimeType): ReactElement {
    const builtin = type === 'builtin';
    const copy = copyOf(type);
    return (
      <>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor='np-agent-name'>
            {t('np.agentForm.name')}
          </FieldLabel>
          <Input
            id='np-agent-name'
            value={name}
            autoFocus={initialType !== null}
            maxLength={100}
            aria-invalid={errors.name ? true : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {errors.name ? <FieldError>{errors.name}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-agent-description'>
            {t('np.agentForm.descriptionLabel')}
          </FieldLabel>
          <Input
            id='np-agent-description'
            value={description}
            maxLength={300}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <SummaryField
          id='np-agent-summary'
          value={summary}
          error={errors.summary}
          onChange={setSummary}
        />
        <CapabilityFields
          value={capabilities}
          instructions={instructions}
          disabled={false}
          runtimeType={type}
          onChange={setCapabilities}
        />
        <Field data-invalid={errors.instructions ? true : undefined}>
          <FieldLabel htmlFor='np-agent-instructions'>
            {t('np.agentForm.instructions')}
          </FieldLabel>
          <Textarea
            id='np-agent-instructions'
            rows={6}
            value={instructions}
            placeholder={t('np.agentForm.instructionsPlaceholder')}
            aria-invalid={errors.instructions ? true : undefined}
            onChange={(event) => setInstructions(event.target.value)}
          />
          {errors.instructions ? (
            <FieldError>{errors.instructions}</FieldError>
          ) : null}
        </Field>
        <Field data-invalid={errors.runtimeId ? true : undefined}>
          <FieldLabel htmlFor='np-agent-runtime'>
            {t('np.agentForm.runtime')}
          </FieldLabel>
          <Select
            items={runtimeItems}
            value={runtimeId}
            onValueChange={(value) => {
              setRuntimeId(value);
              setModel('');
            }}
          >
            <SelectTrigger
              id='np-agent-runtime'
              className='w-full'
              aria-invalid={errors.runtimeId ? true : undefined}
            >
              <SelectValue placeholder={t('np.agentForm.runtimePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {sameType.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  <span className='flex min-w-0 flex-1 items-center gap-2'>
                    <span className='truncate'>{item.name}</span>
                    <span className='text-xs text-muted-foreground'>
                      {builtin
                        ? (item.llmServiceTitle ?? item.llmService)
                        : item.provider}
                    </span>
                    <NpOnlineState
                      online={item.status === 'online'}
                      className='ml-auto'
                    />
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.runtimeId ? (
            <FieldError>{errors.runtimeId}</FieldError>
          ) : runtimes.data && sameType.length === 0 ? (
            <FieldDescription>
              {builtin
                ? t('np.agentType.noRuntimes', {
                    runtimeName: copy.runtimeName,
                  })
                : t('np.agentForm.noRuntimes')}{' '}
              {builtin && !canUseService ? null : (
                <Link
                  to={builtin ? '/runtimes/builtin' : '/runtimes/connect'}
                  className='underline'
                >
                  {builtin
                    ? t('np.runtimeAdd.builtin')
                    : t('np.runtimes.connect')}
                </Link>
              )}
            </FieldDescription>
          ) : (
            <FieldDescription>
              {t('np.agentType.sameTypeHint', {
                runtimeName: copy.runtimeName,
              })}
            </FieldDescription>
          )}
        </Field>
        <div className='grid gap-4 sm:grid-cols-3'>
          {builtin ? (
            <div className='sm:col-span-2'>
              <BuiltinModelField
                id='np-agent-model'
                runtime={runtime}
                value={model}
                onChange={setModel}
              />
            </div>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor='np-agent-provider'>
                  {t('np.agentForm.provider')}
                </FieldLabel>
                <Input
                  id='np-agent-provider'
                  value={runtime?.provider ?? ''}
                  placeholder={t('np.agentForm.providerPlaceholder')}
                  readOnly
                  aria-readonly='true'
                />
              </Field>
              <Field>
                <FieldLabel htmlFor='np-agent-model'>
                  {t('np.agentForm.model')}
                </FieldLabel>
                <Input
                  id='np-agent-model'
                  value={model}
                  placeholder={t('np.agents.defaultModel')}
                  onChange={(event) => setModel(event.target.value)}
                />
              </Field>
            </>
          )}
          <Field data-invalid={errors.maxConcurrentRuns ? true : undefined}>
            <FieldLabel htmlFor='np-agent-max'>
              {t('np.agentForm.maxConcurrentRuns')}
            </FieldLabel>
            <Input
              id='np-agent-max'
              type='number'
              min={1}
              max={100}
              step={1}
              value={maxConcurrentRuns}
              aria-invalid={errors.maxConcurrentRuns ? true : undefined}
              onChange={(event) => setMaxConcurrentRuns(event.target.value)}
            />
            {errors.maxConcurrentRuns ? (
              <FieldError>{errors.maxConcurrentRuns}</FieldError>
            ) : null}
          </Field>
        </div>
        {/* Reasoning effort is a coding tool's flag; a built-in agent has none (§3.1). */}
        {builtin ? null : (
          <AgentKindFields
            idPrefix='np-agent'
            kind={kind}
            reasoningEffort={reasoningEffort}
            onKindChange={setKind}
            onReasoningEffortChange={setReasoningEffort}
          />
        )}
      </>
    );
  }
}

function NewAgentFooter({
  submitting,
}: {
  readonly submitting: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return (
    <>
      <Button
        type='button'
        variant='outline'
        disabled={submitting}
        onClick={() => void close()}
      >
        {t('actions.cancel')}
      </Button>
      <Button type='submit' form={FORM_ID} disabled={submitting}>
        {submitting ? <Spinner data-icon='inline-start' /> : null}
        {submitting ? t('np.common.creating') : t('np.common.create')}
      </Button>
    </>
  );
}
