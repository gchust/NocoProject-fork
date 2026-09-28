import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { NpExecutorSelect } from '@/components/np-executor-select';
import { NpMultiSelect } from '@/components/np-multi-select';
import {
  NpStartDialog,
  type NpStartRequest,
} from '@/components/np-start-dialog';
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
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useRouteOverlay } from '@/components/use-route-overlay';

import { fetchMembers } from '../../api-collab.js';
import { createIssue, fetchAgents, fetchIssueDetail } from '../../api.js';
import { npKeys } from '../../constants.js';
import type {
  CreateIssueInput,
  ExecutorRef,
  StartDecision,
} from '../../types.js';

const FORM_ID = 'np-subtask-new-form';

/**
 * Route `/issues/:issueId/new-subtask` (§J 2): a sub-issue of the open issue, with its stage, the siblings it waits
 * for, and an executor. Choosing an agent asks "start now?" before creating, like assigning one on the detail page.
 */
export default function NewSubtaskPage(): ReactElement {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const handleSubmittingChange = (value: boolean): void => {
    submittingRef.current = value;
    setSubmitting(value);
  };
  return (
    <RouteDialog
      title={t('np.subtasks.newTitle')}
      description={t('np.subtasks.newDescription')}
      className='sm:max-w-xl'
      beforeClose={() => !submittingRef.current}
      footer={<Footer submitting={submitting} />}
    >
      <Body onSubmittingChange={handleSubmittingChange} />
    </RouteDialog>
  );
}

function Body({
  onSubmittingChange,
}: {
  readonly onSubmittingChange: (submitting: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { close } = useRouteOverlay();
  const { issueId = '' } = useParams();

  const parent = useQuery({
    queryKey: npKeys.issue(issueId),
    queryFn: ({ signal }) => fetchIssueDetail(api, issueId, signal),
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState('');
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [executor, setExecutor] = useState<ExecutorRef>({
    type: 'none',
    id: null,
  });
  const [titleError, setTitleError] = useState<string>();
  const [stageError, setStageError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [startRequest, setStartRequest] = useState<NpStartRequest | null>(null);

  const siblings = parent.data?.subtasks ?? [];

  async function create(decision?: StartDecision): Promise<void> {
    setFormError(undefined);
    onSubmittingChange(true);
    const input: CreateIssueInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      parentIssueId: parent.data?.issue.id ?? issueId,
      stage: stage.trim() ? Number(stage) : undefined,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
      executor: executor.type === 'none' ? undefined : executor,
      ...(decision ?? {}),
    };
    try {
      const issue = await createIssue(api, input);
      onSubmittingChange(false);
      toast.add({
        type: 'success',
        title: t('np.issueForm.created', { identifier: issue.identifier }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
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

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = title.trim();
    const stageValue = stage.trim();
    const stageValid = stageValue === '' || /^\d{1,4}$/u.test(stageValue);
    setTitleError(trimmed ? undefined : t('np.issueForm.titleRequired'));
    setStageError(stageValid ? undefined : t('np.subtasks.stageInvalid'));
    if (!trimmed || !stageValid) return;
    if (executor.type === 'agent' && executor.id) {
      const agent = agents.data?.find(
        (candidate) => candidate.id === executor.id,
      );
      setStartRequest({
        agentNames: [agent?.name ?? executor.id],
        autoExecuteSubtasks: parent.data?.issue.autoExecuteSubtasks ?? false,
      });
      return;
    }
    void create();
  }

  return (
    <form id={FORM_ID} onSubmit={submit} noValidate>
      <FieldGroup>
        {formError ? (
          <Alert variant='destructive'>
            <AlertCircleIcon />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <Field data-invalid={titleError ? true : undefined}>
          <FieldLabel htmlFor='np-subtask-title'>
            {t('np.issueForm.titleLabel')}
          </FieldLabel>
          <Input
            id='np-subtask-title'
            value={title}
            autoFocus
            maxLength={500}
            aria-invalid={titleError ? true : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {titleError ? <FieldError>{titleError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-subtask-description'>
            {t('np.issueForm.descriptionLabel')}
          </FieldLabel>
          <Textarea
            id='np-subtask-description'
            rows={4}
            value={description}
            placeholder={t('np.issueForm.descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <div className='grid gap-4 sm:grid-cols-2'>
          <Field data-invalid={stageError ? true : undefined}>
            <FieldLabel htmlFor='np-subtask-stage'>
              {t('np.subtasks.stageLabel')}
            </FieldLabel>
            <Input
              id='np-subtask-stage'
              inputMode='numeric'
              value={stage}
              aria-invalid={stageError ? true : undefined}
              onChange={(event) => setStage(event.target.value)}
            />
            {stageError ? (
              <FieldError>{stageError}</FieldError>
            ) : (
              <FieldDescription>{t('np.subtasks.stageHint')}</FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor='np-subtask-executor'>
              {t('np.properties.executor')}
            </FieldLabel>
            <NpExecutorSelect
              id='np-subtask-executor'
              value={executor}
              agents={agents.data ?? []}
              members={members.data}
              onChange={setExecutor}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor='np-subtask-blocked-by'>
            {t('np.subtasks.blockedByLabel')}
          </FieldLabel>
          <NpMultiSelect
            id='np-subtask-blocked-by'
            options={siblings.map((sibling) => ({
              value: sibling.id,
              label: `${sibling.identifier} ${sibling.title}`,
            }))}
            value={blockedBy}
            onChange={setBlockedBy}
            placeholder={t('np.subtasks.blockedByPlaceholder')}
            emptyText={t('np.subtasks.noSiblings')}
          />
          <FieldDescription>{t('np.subtasks.blockedByHint')}</FieldDescription>
        </Field>
      </FieldGroup>
      <NpStartDialog
        request={startRequest}
        onCancel={() => setStartRequest(null)}
        onDecide={(decision) => {
          setStartRequest(null);
          void create(decision);
        }}
      />
    </form>
  );
}

function Footer({
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
