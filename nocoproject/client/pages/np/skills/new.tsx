import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { RouteDialog } from '@/components/route-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { UnsavedChangesBoundary } from '@/components/unsaved-changes';
import {
  useUnsavedChanges,
  useUnsavedChangesGuard,
} from '@/components/use-unsaved-changes';
import { useRouteOverlay } from '@/components/use-route-overlay';

import { createSkill } from '../api-agent-extras.js';
import { npKeys } from '../constants.js';

const FORM_ID = 'np-skill-new-form';

/** Route `/skills/new`: name and describe a skill; its SKILL.md and files are edited on the skill page it opens. */
export default function NewSkillPage(): ReactElement {
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
      title={t('np.skills.newTitle')}
      description={t('np.skills.newDescription')}
      className='sm:max-w-lg'
      beforeClose={() => !submittingRef.current && unsaved.confirmDiscard()}
      footer={<Footer submitting={submitting} />}
    >
      <UnsavedChangesBoundary guard={unsaved}>
        <Body onSubmittingChange={handleSubmittingChange} />
      </UnsavedChangesBoundary>
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { close } = useRouteOverlay();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const markSaved = useUnsavedChanges(
    Boolean(name.trim() || description.trim()),
  );

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!name.trim()) {
      setNameError(t('np.skills.nameRequired'));
      return;
    }
    setNameError(undefined);
    setFormError(undefined);
    onSubmittingChange(true);
    try {
      const skill = await createSkill(api, {
        name: name.trim(),
        description: description.trim() || null,
        content: `# ${name.trim()}\n`,
      });
      onSubmittingChange(false);
      toast.add({
        type: 'success',
        title: t('np.skills.created', { name: skill.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.skills });
      markSaved();
      await close();
      void navigate(`/skills/${encodeURIComponent(skill.id)}`);
    } catch (error: unknown) {
      onSubmittingChange(false);
      setFormError(
        error instanceof ApiClientError && error.status === 409
          ? t('np.skills.duplicate')
          : error instanceof ApiClientError && error.status === 403
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
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor='np-skill-name'>{t('np.skills.name')}</FieldLabel>
          <Input
            id='np-skill-name'
            value={name}
            autoFocus
            maxLength={100}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameError ? <FieldError>{nameError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-skill-description'>
            {t('np.skills.descriptionLabel')}
          </FieldLabel>
          <Textarea
            id='np-skill-description'
            rows={3}
            value={description}
            placeholder={t('np.skills.descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
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
        {submitting ? t('np.common.creating') : t('np.common.create')}
      </Button>
    </>
  );
}
