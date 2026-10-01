import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { UnsavedChangesBoundary } from '@/components/unsaved-changes';
import {
  useGuardedClose,
  useUnsavedChanges,
  useUnsavedChangesGuard,
} from '@/components/use-unsaved-changes';

import { updateProjectResource } from '../../api-projects.js';
import { npKeys } from '../../constants.js';
import type { ProjectResource } from '../../types.js';
import { isGitRepoUrl } from './resource-url.js';

/**
 * Edit a repository's URL, default branch and label (iteration 1 leftover "repository resource edit"). A single-record edit
 * reached from a row, so it is component state rather than a route (`references/frontend/references/overlay.md`).
 */
export function EditResourceDialog({
  projectId,
  resource,
  onClose,
}: {
  readonly projectId: string;
  readonly resource: ProjectResource | null;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const unsaved = useUnsavedChangesGuard();
  const requestClose = useGuardedClose(unsaved, onClose);
  return (
    <Dialog
      open={resource !== null}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('np.resourceEdit.title')}</DialogTitle>
        </DialogHeader>
        <UnsavedChangesBoundary guard={unsaved}>
          {resource ? (
            <EditForm
              key={resource.id}
              projectId={projectId}
              resource={resource}
              onClose={onClose}
              onCancel={requestClose}
            />
          ) : null}
        </UnsavedChangesBoundary>
      </DialogContent>
    </Dialog>
  );
}

function EditForm({
  projectId,
  resource,
  onClose,
  onCancel,
}: {
  readonly projectId: string;
  readonly resource: ProjectResource;
  readonly onClose: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(resource.url);
  const [defaultRef, setDefaultRef] = useState(resource.defaultRef ?? '');
  const [label, setLabel] = useState(resource.label ?? '');
  const [urlError, setUrlError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(
    url.trim() !== resource.url ||
      defaultRef.trim() !== (resource.defaultRef ?? '') ||
      label.trim() !== (resource.label ?? ''),
  );

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
    setSaving(true);
    try {
      await updateProjectResource(api, projectId, resource.id, {
        url: url.trim(),
        defaultRef: defaultRef.trim() || null,
        label: label.trim() || null,
      });
      toast.add({ type: 'success', title: t('np.resourceEdit.saved') });
      void queryClient.invalidateQueries({ queryKey: npKeys.projects });
      onClose();
    } catch (error: unknown) {
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError && error.code === 'INVALID_URL'
              ? t('np.resources.urlInvalid')
              : t('np.common.requestFailed'),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <FieldGroup>
        <Field data-invalid={urlError ? true : undefined}>
          <FieldLabel htmlFor='np-resource-edit-url'>
            {t('np.resources.url')}
          </FieldLabel>
          <Input
            id='np-resource-edit-url'
            value={url}
            autoFocus
            aria-invalid={urlError ? true : undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
          {urlError ? <FieldError>{urlError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-resource-edit-ref'>
            {t('np.resources.defaultRef')}
          </FieldLabel>
          <Input
            id='np-resource-edit-ref'
            value={defaultRef}
            onChange={(event) => setDefaultRef(event.target.value)}
          />
          <FieldDescription>
            {t('np.resources.defaultRefHint')}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor='np-resource-edit-label'>
            {t('np.resources.label')}
          </FieldLabel>
          <Input
            id='np-resource-edit-label'
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            disabled={saving}
            onClick={onCancel}
          >
            {t('actions.cancel')}
          </Button>
          <Button type='submit' disabled={saving}>
            {saving ? <Spinner data-icon='inline-start' /> : null}
            {t('actions.save')}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}
