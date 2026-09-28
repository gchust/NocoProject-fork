import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

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

import { fetchMembers } from '../api-collab.js';
import { createProject } from '../api-projects.js';
import { fetchMe } from '../api.js';
import { ISSUE_PRIORITIES, npKeys } from '../constants.js';
import { DateField, PropertySelect } from '../issues/detail/property-fields.js';
import type { IssuePriority, ProjectVisibility } from '../types.js';

const FORM_ID = 'np-project-new-form';

/** Route `/projects/new` (§J 4): name, description, visibility, lead, dates and priority; opens the project after. */
export default function NewProjectPage(): ReactElement {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const handleSubmittingChange = (value: boolean): void => {
    submittingRef.current = value;
    setSubmitting(value);
  };
  return (
    <RouteDialog
      title={t('np.projectForm.title')}
      description={t('np.projectForm.description')}
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
  const navigate = useNavigate();
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<ProjectVisibility>('everyone');
  const [leadUserId, setLeadUserId] = useState<string | null>(null);
  const [priority, setPriority] = useState<IssuePriority>('none');
  const [startDate, setStartDate] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const lead = leadUserId ?? me.data?.userId ?? null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('np.projectForm.nameRequired'));
      return;
    }
    setNameError(undefined);
    setFormError(undefined);
    onSubmittingChange(true);
    try {
      const project = await createProject(api, {
        name: trimmed,
        description: description.trim() || undefined,
        visibility,
        leadUserId: lead ?? undefined,
        priority,
        startDate,
        dueDate,
      });
      onSubmittingChange(false);
      toast.add({
        type: 'success',
        title: t('np.projectForm.created', { name: project.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.projects });
      void navigate(`/projects/${encodeURIComponent(project.id)}`, {
        replace: true,
      });
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
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor='np-project-name'>
            {t('np.projectForm.name')}
          </FieldLabel>
          <Input
            id='np-project-name'
            value={name}
            autoFocus
            maxLength={200}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameError ? <FieldError>{nameError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-project-description'>
            {t('np.issueForm.descriptionLabel')}
          </FieldLabel>
          <Textarea
            id='np-project-description'
            rows={3}
            value={description}
            placeholder={t('np.projectForm.descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
          />
          <FieldDescription>
            {t('np.projectForm.descriptionHint')}
          </FieldDescription>
        </Field>
        <div className='grid gap-4 sm:grid-cols-2'>
          <Field>
            <FieldLabel htmlFor='np-project-visibility'>
              {t('np.projects.visibilityLabel')}
            </FieldLabel>
            <PropertySelect
              size='default'
              id='np-project-visibility'
              options={[
                {
                  value: 'everyone',
                  label: t('np.projects.visibility.everyone'),
                },
                {
                  value: 'members',
                  label: t('np.projects.visibility.members'),
                },
              ]}
              value={visibility}
              onChange={(value) =>
                setVisibility(value === 'members' ? 'members' : 'everyone')
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='np-project-lead'>
              {t('np.projects.columns.lead')}
            </FieldLabel>
            <PropertySelect
              size='default'
              id='np-project-lead'
              options={(members.data ?? []).map((member) => ({
                value: member.userId,
                label: member.name,
              }))}
              value={lead}
              noneLabel={t('np.projects.noLead')}
              onChange={setLeadUserId}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='np-project-priority'>
              {t('np.properties.priority')}
            </FieldLabel>
            <PropertySelect
              size='default'
              id='np-project-priority'
              options={ISSUE_PRIORITIES.map((value) => ({
                value,
                label: t(`np.priority.${value}`),
              }))}
              value={priority}
              onChange={(value) => {
                const next = ISSUE_PRIORITIES.find((item) => item === value);
                if (next) setPriority(next);
              }}
            />
          </Field>
          <div className='hidden sm:block' />
          <Field>
            <FieldLabel htmlFor='np-project-start'>
              {t('np.dates.start')}
            </FieldLabel>
            <DateField
              size='default'
              id='np-project-start'
              value={startDate}
              clearLabel={t('np.dates.clearStart')}
              onChange={setStartDate}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='np-project-due'>
              {t('np.dates.due')}
            </FieldLabel>
            <DateField
              size='default'
              id='np-project-due'
              value={dueDate}
              clearLabel={t('np.dates.clearDue')}
              onChange={setDueDate}
            />
          </Field>
        </div>
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
