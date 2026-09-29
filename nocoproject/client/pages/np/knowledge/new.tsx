import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactElement, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { NpRichTextEditor } from '@/components/np-rich-text-editor';
import { RouteDialog } from '@/components/route-dialog';
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

import {
  createKnowledgeDoc,
  fetchKnowledgeDetail,
  slugify,
} from '../api-knowledge.js';
import { fetchProjects } from '../api.js';
import { npKeys } from '../constants.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import { useWorkspaceViewer } from '../use-workspace-viewer.js';
import { writableProjects } from './knowledge-model.js';

const FORM_ID = 'np-knowledge-new-form';

/**
 * Route `/knowledge/new` (§B): a document's project (none = the workspace, owner/admin only), title, slug (derived
 * from the title until edited), one-line summary and Markdown content. Opens the document after it is created.
 */
export default function NewKnowledgePage(): ReactElement {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  return (
    <RouteDialog
      title={t('np.knowledge.form.title')}
      description={t('np.knowledge.form.description')}
      className='sm:max-w-2xl'
      beforeClose={() => !pendingRef.current}
      footer={<Footer pending={pending} />}
    >
      <Body
        onPendingChange={(value) => {
          pendingRef.current = value;
          setPending(value);
        }}
      />
    </RouteDialog>
  );
}

function Body({
  onPendingChange,
}: {
  readonly onPendingChange: (pending: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const { viewer, isAdmin } = useWorkspaceViewer();
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const writable = writableProjects(viewer, projects.data);
  const preset = params.get('project');
  const [projectId, setProjectId] = useState<string | null>(
    preset && preset !== 'workspace' ? preset : null,
  );
  const parentId = params.get('parent') || undefined;
  const parentDoc = useQuery({
    queryKey: npKeys.knowledgeDoc(parentId ?? ''),
    queryFn: ({ signal }) => fetchKnowledgeDetail(api, parentId ?? '', signal),
    enabled: Boolean(parentId),
  });
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [titleError, setTitleError] = useState<string>();
  const effectiveProject =
    projectId ?? (isAdmin ? null : (writable[0]?.id ?? null));

  const create = useMutation({
    mutationFn: () =>
      createKnowledgeDoc(api, {
        projectId: effectiveProject,
        title: title.trim(),
        slug: (slugEdited ? slug : slugify(title)) || undefined,
        summary: summary.trim() || undefined,
        content,
        parentId,
      }),
    onMutate: () => onPendingChange(true),
    onSuccess: (doc) => {
      toast.add({
        type: 'success',
        title: t('np.knowledge.form.created', { title: doc.title }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.knowledge });
      void navigate(`/knowledge/${encodeURIComponent(doc.id)}`, {
        replace: true,
      });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 409
            ? t('np.knowledge.form.slugTaken')
            : error instanceof ApiClientError && error.status === 403
              ? t('np.common.forbidden')
              : t('np.common.requestFailed'),
      }),
    onSettled: () => onPendingChange(false),
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!title.trim()) {
      setTitleError(t('np.knowledge.form.titleRequired'));
      return;
    }
    setTitleError(undefined);
    create.mutate();
  }

  return (
    <form id={FORM_ID} onSubmit={submit} noValidate>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor='np-knowledge-project'>
            {t('np.knowledge.form.project')}
          </FieldLabel>
          <PropertySelect
            id='np-knowledge-project'
            size='default'
            options={(isAdmin ? (projects.data ?? []) : writable).map(
              (project) => ({ value: project.id, label: project.name }),
            )}
            value={effectiveProject}
            noneLabel={isAdmin ? t('np.knowledge.workspace') : undefined}
            onChange={setProjectId}
          />
          <FieldDescription>
            {t('np.knowledge.form.projectHint')}
          </FieldDescription>
        </Field>
        {parentId ? (
          <p className='text-sm text-muted-foreground'>
            {t('np.knowledge.form.parentHint', {
              title: parentDoc.data?.doc.title ?? parentId,
            })}
          </p>
        ) : null}
        <Field data-invalid={titleError ? true : undefined}>
          <FieldLabel htmlFor='np-knowledge-title'>
            {t('np.knowledge.form.titleLabel')}
          </FieldLabel>
          <Input
            id='np-knowledge-title'
            value={title}
            maxLength={200}
            autoFocus
            aria-invalid={titleError ? true : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {titleError ? <FieldError>{titleError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-knowledge-slug'>
            {t('np.knowledge.form.slug')}
          </FieldLabel>
          <Input
            id='np-knowledge-slug'
            value={slugEdited ? slug : slugify(title)}
            maxLength={80}
            className='font-mono text-xs'
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
          />
          <FieldDescription>{t('np.knowledge.form.slugHint')}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor='np-knowledge-summary'>
            {t('np.knowledge.form.summary')}
          </FieldLabel>
          <Textarea
            id='np-knowledge-summary'
            rows={2}
            maxLength={300}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <FieldDescription>
            {t('np.knowledge.form.summaryHint')}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>{t('np.knowledge.form.content')}</FieldLabel>
          <NpRichTextEditor
            value={content}
            onChange={setContent}
            aria-label={t('np.knowledge.form.content')}
            placeholder={t('np.knowledge.form.contentPlaceholder')}
            mentionPlacement='below'
            contentClassName='min-h-40'
          />
        </Field>
      </FieldGroup>
    </form>
  );
}

function Footer({ pending }: { readonly pending: boolean }): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return (
    <>
      <Button variant='outline' disabled={pending} onClick={() => void close()}>
        {t('actions.cancel')}
      </Button>
      <Button type='submit' form={FORM_ID} disabled={pending}>
        {pending ? <Spinner data-icon='inline-start' /> : null}
        {t('np.knowledge.form.create')}
      </Button>
    </>
  );
}
