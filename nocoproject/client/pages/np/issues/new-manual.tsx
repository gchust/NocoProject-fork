import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import type { FileRecord } from '@nocobase/app-plugin-file/client';

import {
  FileUploadField,
  type FileUploadFieldHandle,
  type FileUploadStatus,
} from '@/extensions/nocobase-file-component-ui';
import { NpExecutorSelect } from '@/components/np-executor-select';
import {
  NpStartDialog,
  type NpStartRequest,
} from '@/components/np-start-dialog';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useRouteOverlay } from '@/components/use-route-overlay';

import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_SIZE,
} from '../api-attachments.js';
import { fetchMembers } from '../api-collab.js';
import { fetchWorkspaceSettings } from '../api-iter2.js';
import { readDefaultProcess } from '../api-iter4.js';
import { createIssue, fetchAgents, fetchMe, fetchProjects } from '../api.js';
import { ISSUE_PRIORITIES, npKeys } from '../constants.js';
import type { ExecutorRef, IssuePriority, StartDecision } from '../types.js';
import type { ProcessChoice } from '../types-iter4.js';
import {
  usePasteDrop,
  uploadErrorTitle,
  useAttachmentRepository,
  useFileLabels,
} from './detail/use-attachments.js';
import { PropertySelect } from './detail/property-fields.js';
import { ProcessSelect } from './process-fields.js';

const FORM_ID = 'np-issue-new-form';

/**
 * The Manual tab of "New issue" (iteration 4 §D; the iteration 1–3 form): title, description, priority, project (`?project=`
 * preselects it), owner (the signed-in user by default), executor (an agent asks "start now?" before creating),
 * process (iteration 4 §B, starting at the workspace default) and session mode (iteration 2 §J). NP-78: attachments
 * upload as they are chosen, dropped or pasted into the description, and are attached by `attachmentIds` when the
 * issue is created; submitting waits for them.
 */
export function ManualIssueForm({
  onSubmittingChange,
}: {
  readonly onSubmittingChange: (submitting: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { close } = useRouteOverlay();

  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  // The workspace default process (§A) is where the select starts; a member who may not read settings starts at Automatic.
  const settings = useQuery({
    queryKey: npKeys.settings,
    queryFn: () => fetchWorkspaceSettings(api),
    retry: false,
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const repository = useAttachmentRepository();
  const fileLabels = useFileLabels();
  const uploadRef = useRef<FileUploadFieldHandle>(null);
  const pasteDrop = usePasteDrop(uploadRef);
  const [files, setFiles] = useState<readonly FileRecord[]>([]);
  const [uploadStatus, setUploadStatus] = useState<FileUploadStatus>('idle');
  const [priority, setPriority] = useState<IssuePriority>('none');
  // Opened from a project, or from the list filtered by one, the new issue starts in that project.
  const [searchParams] = useSearchParams();
  const [projectId, setProjectId] = useState(
    searchParams.get('project') ?? 'none',
  );
  const [executor, setExecutor] = useState<ExecutorRef>({
    type: 'none',
    id: null,
  });
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [sessionMode, setSessionMode] = useState(false);
  const [chosenProcess, setChosenProcess] = useState<ProcessChoice | null>(
    null,
  );
  const process =
    chosenProcess ?? readDefaultProcess(settings.data?.defaultProcess);
  const [titleError, setTitleError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [startRequest, setStartRequest] = useState<NpStartRequest | null>(null);
  const owner = ownerUserId ?? me.data?.userId ?? null;

  const priorityItems = ISSUE_PRIORITIES.map((value) => ({
    value,
    label: t(`np.priority.${value}`),
  }));
  const projectItems = [
    { value: 'none', label: t('np.issueForm.noProject') },
    ...(projects.data ?? []).map((project) => ({
      value: project.id,
      label: project.name,
    })),
  ];

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError(t('np.issueForm.titleRequired'));
      return;
    }
    setTitleError(undefined);
    if (uploadStatus !== 'idle') {
      setFormError(
        t(
          uploadStatus === 'uploading'
            ? 'np.attachments.stillUploading'
            : 'np.attachments.fixFailed',
        ),
      );
      return;
    }
    if (executor.type === 'agent' && executor.id) {
      const agent = agents.data?.find((item) => item.id === executor.id);
      setStartRequest({
        agentNames: [agent?.name ?? executor.id],
        autoExecuteSubtasks: false,
      });
      return;
    }
    void create();
  }

  async function create(decision?: StartDecision): Promise<void> {
    setFormError(undefined);
    onSubmittingChange(true);
    try {
      const issue = await createIssue(api, {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        projectId: projectId === 'none' ? undefined : projectId,
        ownerUserId: owner ?? undefined,
        executor: executor.type === 'none' ? undefined : executor,
        executionMode: sessionMode ? 'session' : undefined,
        // Always explicit: Automatic asks the server's classifier even when the workspace default is another process.
        process,
        attachmentIds:
          files.length > 0 ? files.map((file) => file.id) : undefined,
        ...(decision ?? {}),
      });
      onSubmittingChange(false);
      toast.add({
        type: 'success',
        title: t('np.issueForm.created', { identifier: issue.identifier }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void close();
    } catch (error: unknown) {
      onSubmittingChange(false);
      setFormError(
        error instanceof ApiClientError && error.status === 403
          ? t('np.common.forbidden')
          : error instanceof ApiClientError &&
              error.code === 'MANAGER_NOT_EXECUTOR'
            ? t('np.agentForm.managerNotExecutor')
            : error instanceof ApiClientError &&
                error.code === 'INVALID_ATTACHMENT'
              ? t('np.attachments.invalid')
              : t('np.common.requestFailed'),
      );
    }
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
          <FieldLabel htmlFor='np-issue-title'>
            {t('np.issueForm.titleLabel')}
          </FieldLabel>
          <Input
            id='np-issue-title'
            value={title}
            autoFocus
            maxLength={500}
            aria-invalid={titleError ? true : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {titleError ? <FieldError>{titleError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-issue-description'>
            {t('np.issueForm.descriptionLabel')}
          </FieldLabel>
          <Textarea
            id='np-issue-description'
            rows={5}
            value={description}
            placeholder={t('np.issueForm.descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
            {...pasteDrop}
          />
        </Field>
        <Field>
          <FieldLabel>{t('np.attachments.title')}</FieldLabel>
          <FileUploadField
            ref={uploadRef}
            repository={repository}
            value={files}
            onChange={setFiles}
            onStatusChange={setUploadStatus}
            multiple
            maxFiles={ATTACHMENT_MAX_FILES}
            maxSize={ATTACHMENT_MAX_FILE_SIZE}
            labels={fileLabels}
            onError={(error) =>
              toast.add({
                type: 'error',
                priority: 'high',
                title: uploadErrorTitle(t, error),
              })
            }
          />
        </Field>
        <div className='grid gap-4 sm:grid-cols-2'>
          <Field>
            <FieldLabel htmlFor='np-issue-priority'>
              {t('np.properties.priority')}
            </FieldLabel>
            <Select
              items={priorityItems}
              value={priority}
              onValueChange={(value) => {
                if (value) setPriority(value);
              }}
            >
              <SelectTrigger id='np-issue-priority' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {priorityItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor='np-issue-project'>
              {t('np.issueForm.projectLabel')}
            </FieldLabel>
            <Select
              items={projectItems}
              value={projectId}
              onValueChange={(value) => setProjectId(value ?? 'none')}
            >
              <SelectTrigger id='np-issue-project' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projectItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor='np-issue-owner'>
              {t('np.properties.owner')}
            </FieldLabel>
            <PropertySelect
              id='np-issue-owner'
              size='default'
              options={(members.data ?? []).map((member) => ({
                value: member.userId,
                label:
                  member.userId === me.data?.userId
                    ? `${member.name} ${t('np.properties.you')}`
                    : member.name,
              }))}
              value={owner}
              disabled={!members.data}
              onChange={(value) => setOwnerUserId(value)}
            />
            <FieldDescription>{t('np.issueExtra.ownerHint')}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor='np-issue-executor'>
              {t('np.properties.executor')}
            </FieldLabel>
            <NpExecutorSelect
              id='np-issue-executor'
              value={executor}
              agents={agents.data ?? []}
              members={members.data}
              onChange={setExecutor}
            />
            <FieldDescription>
              {t('np.issueForm.executorHint')}
            </FieldDescription>
          </Field>
          <Field className='sm:col-span-2'>
            <FieldLabel htmlFor='np-issue-process'>
              {t('np.process.label')}
            </FieldLabel>
            <ProcessSelect
              id='np-issue-process'
              value={process}
              onChange={setChosenProcess}
            />
            <FieldDescription>{t('np.process.hint')}</FieldDescription>
          </Field>
        </div>
        <Field orientation='horizontal'>
          <FieldContent>
            <FieldLabel htmlFor='np-issue-session-mode'>
              {t('np.session.modeLabel')}
            </FieldLabel>
            <FieldDescription>{t('np.session.modeHint')}</FieldDescription>
          </FieldContent>
          <Switch
            id='np-issue-session-mode'
            checked={sessionMode}
            onCheckedChange={setSessionMode}
          />
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

export function ManualIssueFooter({
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
