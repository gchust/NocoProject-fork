import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation } from '@tanstack/react-query';
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

import { revealWebhookSecret } from '../api-iter2.js';

/** A value in monospace with a copy button (the webhook URL and the revealed secret). */
export function CopyValue({ value }: { readonly value: string }): ReactElement {
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

/**
 * NP-227: every repository's webhook signs with the one saved secret, so whoever may change it (the settings item
 * `nocoproject.github` `update`) can show it again to add the webhook to another repository. Fetched only on click
 * (`POST …/webhook-secret/reveal`) and kept in this component's state, never in the query cache.
 */
export function WebhookSecretReveal(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [secret, setSecret] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () => revealWebhookSecret(api),
    onSuccess: (result) => {
      if (result.webhookSecret) setSecret(result.webhookSecret);
      else
        toast.add({
          type: 'error',
          priority: 'high',
          title: t('np.repoWebhook.secretNotSet'),
        });
    },
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
  });
  const shown = secret !== null;

  return (
    <span className='flex min-w-0 flex-wrap items-center gap-1'>
      <Button
        type='button'
        variant='outline'
        size='sm'
        aria-pressed={shown}
        disabled={reveal.isPending}
        onClick={() => (shown ? setSecret(null) : reveal.mutate())}
      >
        {reveal.isPending ? (
          <Spinner data-icon='inline-start' />
        ) : shown ? (
          <EyeOffIcon data-icon='inline-start' />
        ) : (
          <EyeIcon data-icon='inline-start' />
        )}
        {shown
          ? t('np.githubSecrets.hideSaved')
          : t('np.githubSecrets.showSaved')}
      </Button>
      {shown ? <CopyValue value={secret} /> : null}
    </span>
  );
}
