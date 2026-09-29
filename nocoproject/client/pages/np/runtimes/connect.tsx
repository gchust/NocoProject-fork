import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { RouteDialog } from '@/components/route-dialog';
import { Button } from '@/components/ui/button';
import { useRouteOverlay } from '@/components/use-route-overlay';
import { cliInstallCommand } from '../constants.js';
import { CommandLine } from './command-line.js';
import { useServerUrl } from './use-server-url.js';

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
  const serverUrl = useServerUrl();
  const apiKeyPlaceholder = t('np.connect.apiKeyPlaceholder');

  const steps = [
    { title: t('np.connect.install'), command: cliInstallCommand(serverUrl) },
    {
      title: t('np.connect.login'),
      command: `nocoproject login --server ${serverUrl} --api-key <${apiKeyPlaceholder}>`,
      hint: t('np.connect.apiKeyHint'),
    },
    // NP-150: a boot service running the installed CLI, not a daemon started by hand.
    {
      title: t('np.connect.start'),
      command: 'nocoproject daemon install',
      hint: t('np.connect.startHint'),
    },
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

function ConnectFooter(): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return <Button onClick={() => void close()}>{t('np.connect.done')}</Button>;
}
