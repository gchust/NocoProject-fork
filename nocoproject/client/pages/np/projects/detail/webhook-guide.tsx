import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, CopyIcon, ExternalLinkIcon } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { Link } from 'react-router';

import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { fetchGitConnection } from '../../api-iter2.js';
import { npKeys } from '../../constants.js';
import { useWorkspaceViewer } from '../../use-workspace-viewer.js';
import { githubRepoOf } from './resource-url.js';

/**
 * How to add NocoProject's webhook to one GitHub repository (NP-118): each repository needs its own, or merged pull
 * requests never close their cards or move their issues. Owner/admin see the webhook URL from `/config/github`;
 * the connection is admin-only, so everyone else is pointed at an admin. The secret is write-only and never shown.
 */
export function GithubWebhookGuide({
  repoUrl,
}: {
  readonly repoUrl: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const viewer = useWorkspaceViewer();
  const connection = useQuery({
    queryKey: npKeys.gitConnection,
    queryFn: () => fetchGitConnection(api),
    enabled: viewer.isAdmin,
    retry: false,
  });
  const repo = githubRepoOf(repoUrl);
  const settingsLink = (
    <Link to='/config/github' className='underline underline-offset-4'>
      {t('np.repoWebhook.settingsLink')}
    </Link>
  );

  return (
    <ol className='list-decimal space-y-2 pl-5 text-sm marker:text-muted-foreground'>
      <li>
        {repo ? (
          <>
            {t('np.repoWebhook.stepOpen', { repo: repo.fullName })}{' '}
            <a
              href={repo.webhookSettingsUrl}
              target='_blank'
              rel='noreferrer'
              className='inline-flex items-center gap-0.5 underline underline-offset-4'
            >
              {t('np.repoWebhook.openSettings')}
              <ExternalLinkIcon className='size-3.5' aria-hidden='true' />
            </a>
          </>
        ) : (
          t('np.repoWebhook.stepOpenGeneric')
        )}
      </li>
      <li>
        <Step label='Payload URL'>
          {connection.data ? (
            <CopyValue value={connection.data.webhookUrl} />
          ) : (
            <span className='text-muted-foreground'>
              {viewer.isAdmin ? settingsLink : t('np.repoWebhook.askAdmin')}
            </span>
          )}
        </Step>
      </li>
      <li>
        <Step label='Content type'>
          <code className='font-mono text-xs'>application/json</code>
        </Step>
      </li>
      <li>
        <Step label='Secret'>
          <span>
            {t('np.repoWebhook.secret')} {viewer.isAdmin ? settingsLink : null}
          </span>
          {connection.data && !connection.data.webhookSecretSet ? (
            <NpTag tone='amber' dot>
              {t('np.repoWebhook.secretNotSet')}
            </NpTag>
          ) : null}
        </Step>
      </li>
      <li>
        <Step label='Which events'>{t('np.repoWebhook.events')}</Step>
      </li>
      <li>{t('np.repoWebhook.stepSave')}</li>
    </ol>
  );
}

function Step({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
      <span className='font-medium'>{label}</span>
      {children}
    </div>
  );
}

function CopyValue({ value }: { readonly value: string }): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
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
    <span className='flex min-w-0 items-center gap-1'>
      <code className='min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
        {value}
      </code>
      <Button
        type='button'
        variant='ghost'
        size='icon-xs'
        aria-label={copied ? t('np.connect.copied') : t('np.connect.copy')}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </span>
  );
}

/** The guide for one repository row, opened from the resources list. */
export function GithubWebhookDialog({
  repoUrl,
  onClose,
}: {
  readonly repoUrl: string | null;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog
      open={repoUrl !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{t('np.repoWebhook.title')}</DialogTitle>
          <DialogDescription>
            {t('np.repoWebhook.description')}
          </DialogDescription>
        </DialogHeader>
        {repoUrl !== null ? <GithubWebhookGuide repoUrl={repoUrl} /> : null}
      </DialogContent>
    </Dialog>
  );
}
