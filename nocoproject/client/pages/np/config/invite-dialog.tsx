import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';

import { NpMultiSelect } from '@/components/np-multi-select';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import {
  createInvitations,
  isEmailAddress,
  parseEmailList,
} from '../api-invitations.js';
import { npKeys } from '../constants.js';
import type { InvitationResult } from '../types-invitations.js';

export interface InviteProjectOption {
  readonly id: string;
  readonly name: string;
}

/**
 * "邀请成员" (NP-88): several addresses at once (one per line, or separated by commas or spaces) and the projects the
 * invitees join as members. Owner/admin may leave the projects empty; a project lead chooses among the projects they
 * lead (`projects` is already narrowed to those). After sending, the dialog shows each address's outcome; an address
 * whose email could not be sent shows its link to copy and forward.
 */
export function InviteDialog({
  open,
  projects,
  requireProject,
  onClose,
}: {
  readonly open: boolean;
  readonly projects: readonly InviteProjectOption[];
  readonly requireProject: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{t('np.invitations.dialogTitle')}</DialogTitle>
          <DialogDescription>
            {t('np.invitations.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <InviteForm
            projects={projects}
            requireProject={requireProject}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function InviteForm({
  projects,
  requireProject,
  onClose,
}: {
  readonly projects: readonly InviteProjectOption[];
  readonly requireProject: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [emailError, setEmailError] = useState<string>();
  const [projectError, setProjectError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<InvitationResult[] | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const emails = parseEmailList(text);
    const invalid = emails.filter((email) => !isEmailAddress(email));
    setEmailError(
      emails.length === 0
        ? t('np.invitations.emailsRequired')
        : invalid.length > 0
          ? t('np.invitations.emailsInvalid', { emails: invalid.join(', ') })
          : emails.length > 50
            ? t('np.invitations.emailsTooMany')
            : undefined,
    );
    const missingProject = requireProject && projectIds.length === 0;
    setProjectError(
      missingProject ? t('np.invitations.projectRequired') : undefined,
    );
    if (
      emails.length === 0 ||
      invalid.length > 0 ||
      emails.length > 50 ||
      missingProject
    )
      return;
    setSaving(true);
    try {
      const sent = await createInvitations(api, { emails, projectIds });
      setResults(sent);
      toast.add({
        type: 'success',
        title: t('np.invitations.sent', { number: sent.length }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.members });
    } catch (error: unknown) {
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.code === 'FORBIDDEN'
            ? t('np.invitations.forbidden')
            : t('np.common.requestFailed'),
      });
    } finally {
      setSaving(false);
    }
  }

  if (results) {
    return (
      <>
        <InviteResults results={results} />
        <DialogFooter>
          <Button type='button' onClick={onClose}>
            {t('np.invitations.done')}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor='np-invite-emails'>
            {t('np.invitations.emails')}
          </FieldLabel>
          <Textarea
            id='np-invite-emails'
            rows={4}
            value={text}
            autoFocus
            placeholder='alice@example.com&#10;bob@example.com'
            aria-invalid={emailError ? true : undefined}
            onChange={(event) => setText(event.target.value)}
          />
          {emailError ? (
            <FieldError>{emailError}</FieldError>
          ) : (
            <FieldDescription>
              {t('np.invitations.emailsHint')}
            </FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-invite-projects'>
            {t('np.invitations.projects')}
          </FieldLabel>
          <NpMultiSelect
            id='np-invite-projects'
            aria-label={t('np.invitations.projects')}
            options={projects.map((project) => ({
              value: project.id,
              label: project.name,
            }))}
            value={projectIds}
            onChange={setProjectIds}
            placeholder={t('np.invitations.projectsPlaceholder')}
            emptyText={t('np.invitations.noProjects')}
          />
          {projectError ? (
            <FieldError>{projectError}</FieldError>
          ) : (
            <FieldDescription>
              {t('np.invitations.projectsHint')}
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
      <DialogFooter className='mt-6'>
        <Button type='button' variant='outline' onClick={onClose}>
          {t('actions.cancel')}
        </Button>
        <Button type='submit' disabled={saving}>
          {saving ? <Spinner /> : null}
          {t('np.invitations.send')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function outcomeLabel(
  t: (key: string) => string,
  result: InvitationResult,
): string {
  if (result.outcome === 'added') return t('np.invitations.outcome.added');
  if (result.outcome === 'alreadyMember')
    return t('np.invitations.outcome.alreadyMember');
  return result.emailSent
    ? t('np.invitations.outcome.sent')
    : t('np.invitations.outcome.notSent');
}

/** One row per address; a link that could not be emailed is shown once, with a copy button. */
export function InviteResults({
  results,
}: {
  readonly results: readonly InvitationResult[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ul className='space-y-3' aria-label={t('np.invitations.resultsLabel')}>
      {results.map((result) => (
        <li key={result.email} className='space-y-2'>
          <div className='flex items-center justify-between gap-3'>
            <span className='min-w-0 truncate text-sm'>{result.email}</span>
            <NpTag
              tone={
                result.outcome === 'invited' && !result.emailSent
                  ? 'amber'
                  : 'green'
              }
            >
              {outcomeLabel(t, result)}
            </NpTag>
          </div>
          {result.inviteUrl ? <CopyLink url={result.inviteUrl} /> : null}
        </li>
      ))}
    </ul>
  );
}

function CopyLink({ url }: { readonly url: string }): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.connect.copyFailed'),
      });
    }
  }
  return (
    <div className='flex gap-2'>
      <Input
        value={url}
        readOnly
        aria-label={t('np.invitations.link')}
        className='font-mono text-xs'
      />
      <Button
        type='button'
        variant='outline'
        size='icon'
        aria-label={copied ? t('np.connect.copied') : t('np.connect.copy')}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
