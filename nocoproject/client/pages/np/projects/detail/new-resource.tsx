import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useRef, useState } from 'react';
import { useParams } from 'react-router';

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
import { toast } from '@/components/ui/toast';
import { useRouteOverlay } from '@/components/use-route-overlay';

import { addProjectResource } from '../../api-projects.js';
import { npKeys } from '../../constants.js';
import { githubRepoOf, isGitRepoUrl } from './resource-url.js';
import { GithubWebhookGuide } from './webhook-guide.js';

const FORM_ID = 'np-resource-new-form';

/**
 * Route `/projects/:projectId/resources/new` (§J 4): attach a git repository to the project. A GitHub URL also shows
 * the webhook steps for it (NP-118).
 */
export default function NewResourcePage(): ReactElement {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const handleSubmittingChange = (value: boolean): void => {
    submittingRef.current = value;
    setSubmitting(value);
  };
  return (
    <RouteDialog
      title={t('np.resources.newTitle')}
      description={t('np.resources.newDescription')}
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
  const { projectId = '' } = useParams();
  const [url, setUrl] = useState('');
  const [defaultRef, setDefaultRef] = useState('');
  const [label, setLabel] = useState('');
  const [urlError, setUrlError] = useState<string>();
  const [formError, setFormError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isGitRepoUrl(url)) {
      setUrlError(
        url.trim()
          ? t('np.resources.urlInvalid')
          : t('np.resources.urlRequired'),
      );
      return;
    }
    setUrlError(undefined);
    setFormError(undefined);
    onSubmittingChange(true);
    try {
      await addProjectResource(api, projectId, {
        type: 'gitRepo',
        url: url.trim(),
        defaultRef: defaultRef.trim() || undefined,
        label: label.trim() || undefined,
      });
      onSubmittingChange(false);
      toast.add({ type: 'success', title: t('np.resources.added') });
      void queryClient.invalidateQueries({ queryKey: npKeys.projects });
      void close();
    } catch (error: unknown) {
      onSubmittingChange(false);
      setFormError(
        error instanceof ApiClientError && error.status === 403
          ? t('np.common.forbidden')
          : error instanceof ApiClientError && error.status === 409
            ? t('np.resources.duplicate')
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
        <Field data-invalid={urlError ? true : undefined}>
          <FieldLabel htmlFor='np-resource-url'>
            {t('np.resources.url')}
          </FieldLabel>
          <Input
            id='np-resource-url'
            value={url}
            autoFocus
            placeholder='https://github.com/owner/repo.git'
            aria-invalid={urlError ? true : undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
          {urlError ? (
            <FieldError>{urlError}</FieldError>
          ) : (
            <FieldDescription>{t('np.resources.urlHint')}</FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-resource-ref'>
            {t('np.resources.defaultRef')}
          </FieldLabel>
          <Input
            id='np-resource-ref'
            value={defaultRef}
            placeholder='main'
            onChange={(event) => setDefaultRef(event.target.value)}
          />
          <FieldDescription>
            {t('np.resources.defaultRefHint')}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor='np-resource-label'>
            {t('np.resources.label')}
          </FieldLabel>
          <Input
            id='np-resource-label'
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        {githubRepoOf(url) ? (
          <div className='space-y-2 rounded-lg border bg-muted/40 p-3'>
            <p className='text-sm text-muted-foreground'>
              {t('np.repoWebhook.newHint')}
            </p>
            <GithubWebhookGuide repoUrl={url} />
          </div>
        ) : null}
      </FieldGroup>
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
        {submitting ? t('np.common.adding') : t('np.resources.addSubmit')}
      </Button>
    </>
  );
}
