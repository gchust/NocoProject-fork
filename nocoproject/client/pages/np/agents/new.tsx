import { CapabilityFields } from './capability-fields.js';
import type { AgentCapability } from '../agent-capabilities.js';
import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { NpOnlineState } from '@/components/np-badges';
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
import { npKeys } from '../constants.js';
import type { AgentKind, ReasoningEffort } from '../types-iter4.js';
import { AgentKindFields } from './agent-kind-fields.js';
import { SummaryField } from './summary-field.js';

const FORM_ID = 'np-agent-new-form';
const DEFAULT_MAX_CONCURRENT_RUNS = 6;
const DEFAULT_CAPABILITIES: readonly AgentCapability[] = [
  'context.read',
  'comment.create',
];

type FieldName =
  'name' | 'summary' | 'instructions' | 'runtimeId' | 'maxConcurrentRuns';

/** Route `/agents/new`: create an agent bound to one runtime, of a kind (iteration 4 §C: Coding / Project manager). */
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
    useSearchParams()[0].get('kind') === 'manager' ? 'manager' : 'coder',
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
      reasoningEffort !== null,
  );

  const runtime = runtimes.data?.find((item) => item.id === runtimeId);
  const runtimeItems = (runtimes.data ?? []).map((item) => ({
    value: item.id,
    label: `${item.name} · ${item.provider}`,
  }));

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
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0 || !runtime) return;
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
        provider: runtime.provider,
        model: model.trim() || undefined,
        maxConcurrentRuns: Number(maxConcurrentRuns),
        kind,
        reasoningEffort,
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
          : t('np.common.requestFailed'),
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
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor='np-agent-name'>
            {t('np.agentForm.name')}
          </FieldLabel>
          <Input
            id='np-agent-name'
            value={name}
            autoFocus
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
            onValueChange={(value) => setRuntimeId(value)}
          >
            <SelectTrigger
              id='np-agent-runtime'
              className='w-full'
              aria-invalid={errors.runtimeId ? true : undefined}
            >
              <SelectValue placeholder={t('np.agentForm.runtimePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {(runtimes.data ?? []).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  <span className='flex min-w-0 flex-1 items-center gap-2'>
                    <span className='truncate'>{item.name}</span>
                    <span className='text-xs text-muted-foreground'>
                      {item.provider}
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
          ) : runtimes.data && runtimes.data.length === 0 ? (
            <FieldDescription>
              {t('np.agentForm.noRuntimes')}{' '}
              <Link to='/runtimes/connect' className='underline'>
                {t('np.runtimes.connect')}
              </Link>
            </FieldDescription>
          ) : null}
        </Field>
        <div className='grid gap-4 sm:grid-cols-3'>
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
        <AgentKindFields
          idPrefix='np-agent'
          kind={kind}
          reasoningEffort={reasoningEffort}
          onKindChange={setKind}
          onReasoningEffortChange={setReasoningEffort}
        />
      </FieldGroup>
    </form>
  );
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
