import { useTranslation } from '@nocobase/i18n/client';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useHref } from 'react-router';

import { RouteDialog } from '@/components/route-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useRouteOverlay } from '@/components/use-route-overlay';
import { cliInstallCommand } from '../constants.js';

/** Route `/runtimes/connect`: how to connect a computer. Instructions only; nothing is submitted. */
export default function ConnectRuntimePage(): ReactElement {
  const { t } = useTranslation();
  return (
    <RouteDialog
      title={t('np.connect.title')}
      description={t('np.connect.description')}
      className='sm:max-w-2xl'
      footer={<ConnectFooter />}
    >
      <ConnectSteps />
    </RouteDialog>
  );
}

function ConnectSteps(): ReactElement {
  const { t } = useTranslation();
  // The command needs the application's public address including its base path. The router's basename is that path;
  // this value is shown to the user, not used to call the API.
  const basePath = useHref('/');
  const serverUrl = new URL(basePath, window.location.origin).href.replace(
    /\/+$/u,
    '',
  );
  const apiKeyPlaceholder = t('np.connect.apiKeyPlaceholder');

  const steps = [
    { title: t('np.connect.install'), command: cliInstallCommand(serverUrl) },
    {
      title: t('np.connect.login'),
      command: `nocoproject login --server ${serverUrl} --api-key <${apiKeyPlaceholder}>`,
      hint: t('np.connect.apiKeyHint'),
    },
    { title: t('np.connect.start'), command: 'nocoproject daemon start' },
  ];

  return (
    <ol className='space-y-5'>
      {steps.map((step, index) => (
        <li key={step.command} className='space-y-2'>
          <p className='text-sm font-medium'>
            {index + 1}. {step.title}
          </p>
          <CommandLine command={step.command} />
          {step.hint ? (
            <p className='text-xs text-muted-foreground'>{step.hint}</p>
          ) : null}
        </li>
      ))}
      <li className='text-sm text-muted-foreground'>{t('np.connect.after')}</li>
    </ol>
  );
}

function CommandLine({ command }: { readonly command: string }): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
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
    <div className='flex items-start gap-2 rounded-lg border bg-muted p-2 pl-3'>
      <code className='min-w-0 flex-1 py-1 font-mono text-xs break-all select-all'>
        {command}
      </code>
      <Button
        variant='ghost'
        size='icon-sm'
        aria-label={copied ? t('np.connect.copied') : t('np.connect.copy')}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

function ConnectFooter(): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return <Button onClick={() => void close()}>{t('np.connect.done')}</Button>;
}
