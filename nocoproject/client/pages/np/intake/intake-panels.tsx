import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, WandSparklesIcon } from 'lucide-react';
import type { FileRecord } from '@nocobase/app-plugin-file/client';
import { type ReactElement, useRef, useState } from 'react';

import {
  FileUploadField,
  type FileUploadFieldHandle,
  type FileUploadStatus,
} from '@/extensions/nocobase-file-component-ui';

import { NpDetailSkeleton } from '@/components/np-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_SIZE,
} from '../api-attachments.js';
import { createIntakeBatch, fetchIntakeBatch } from '../api-intake.js';
import { fetchProjects } from '../api.js';
import { npKeys } from '../constants.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import {
  usePasteDrop,
  uploadErrorTitle,
  useAttachmentRepository,
  useFileLabels,
} from '../issues/detail/use-attachments.js';
import { BatchEditor } from './batch-editor.js';

/**
 * The two panels of batch entry (iteration 2 §E), now the AI draft tab of "New issue" (iteration 4 §D): the composer that
 * sends the description or pasted list to the parser, and the editor of one parsed batch. The dialog
 * (`issues/new.tsx`) switches between them by `?batch=`. NP-78: the composer takes attachments (choose, drop, or paste
 * files into the description) that travel with the batch and end up on the issues it creates; the AI parser reads
 * their text, so the description may stay empty when files are attached.
 */
export function IntakeComposer({
  initialProjectId,
  onParsed,
}: {
  readonly initialProjectId: string | null;
  readonly onParsed: (batchId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [rawContent, setRawContent] = useState('');
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [error, setError] = useState<string>();
  const repository = useAttachmentRepository();
  const fileLabels = useFileLabels();
  const uploadRef = useRef<FileUploadFieldHandle>(null);
  const pasteDrop = usePasteDrop(uploadRef);
  const [files, setFiles] = useState<readonly FileRecord[]>([]);
  const [uploadStatus, setUploadStatus] = useState<FileUploadStatus>('idle');
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const parse = useMutation({
    mutationFn: () =>
      createIntakeBatch(api, {
        source: 'paste',
        rawContent,
        projectId: projectId ?? undefined,
        attachmentIds:
          files.length > 0 ? files.map((file) => file.id) : undefined,
      }),
    onSuccess: (detail) => {
      toast.add({
        type: 'success',
        title: t('np.intake.parsedToast', { count: detail.drafts.length }),
      });
      queryClient.setQueryData(npKeys.intakeBatch(detail.batch.id), detail);
      onParsed(detail.batch.id);
    },
    onError: (failure) =>
      setError(
        failure instanceof ApiClientError && failure.status === 403
          ? t('np.common.forbidden')
          : failure instanceof ApiClientError &&
              failure.code === 'INVALID_ATTACHMENT'
            ? t('np.attachments.invalid')
            : failure instanceof ApiClientError &&
                failure.code === 'INVALID_FIELD' &&
                !rawContent.trim()
              ? t('np.attachments.needText')
              : t('np.intake.parseFailed'),
      ),
  });

  const tooLong = rawContent.length > 50_000;
  return (
    <section className='space-y-4'>
      {error ? (
        <Alert variant='destructive'>
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field data-invalid={parse.isError || tooLong ? true : undefined}>
        <FieldLabel htmlFor='np-intake-raw'>
          {t('np.newIssue.requirementLabel')}
        </FieldLabel>
        <Textarea
          id='np-intake-raw'
          value={rawContent}
          rows={8}
          className='min-h-40'
          autoFocus
          placeholder={t('np.newIssue.requirementPlaceholder')}
          onChange={(event) => setRawContent(event.target.value)}
          {...pasteDrop}
        />
        {tooLong ? <FieldError>{t('np.intake.rawTooLong')}</FieldError> : null}
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
          onError={(failure) =>
            toast.add({
              type: 'error',
              priority: 'high',
              title: uploadErrorTitle(t, failure),
            })
          }
        />
      </Field>
      <div className='flex flex-wrap items-end gap-3'>
        <Field className='max-w-xs flex-1'>
          <FieldLabel htmlFor='np-intake-project'>
            {t('np.issueForm.projectLabel')}
          </FieldLabel>
          <PropertySelect
            id='np-intake-project'
            size='default'
            options={(projects.data ?? []).map((project) => ({
              value: project.id,
              label: project.name,
            }))}
            value={projectId}
            noneLabel={t('np.issueForm.noProject')}
            onChange={setProjectId}
          />
        </Field>
        <Button
          className='ml-auto'
          disabled={
            parse.isPending ||
            (!rawContent.trim() && files.length === 0) ||
            tooLong ||
            uploadStatus !== 'idle'
          }
          onClick={() => {
            setError(undefined);
            parse.mutate();
          }}
        >
          {parse.isPending ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <WandSparklesIcon data-icon='inline-start' />
          )}
          {parse.isPending ? t('np.newIssue.parsing') : t('np.newIssue.parse')}
        </Button>
      </div>
    </section>
  );
}

export function IntakeBatchView({
  batchId,
  onClose,
}: {
  readonly batchId: string;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const batch = useQuery({
    queryKey: npKeys.intakeBatch(batchId),
    queryFn: ({ signal }) => fetchIntakeBatch(api, batchId, signal),
  });
  if (batch.isError && !batch.data) {
    return (
      <Alert variant='destructive'>
        <AlertCircleIcon />
        <AlertDescription>
          {batch.error instanceof ApiClientError && batch.error.status === 404
            ? t('np.intake.notFound')
            : t('np.common.requestFailed')}
        </AlertDescription>
      </Alert>
    );
  }
  if (!batch.data) return <NpDetailSkeleton />;
  return <BatchEditor detail={batch.data} onClose={onClose} />;
}
