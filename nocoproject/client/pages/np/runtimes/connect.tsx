import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, type ReactNode, useState } from 'react';

import { RouteDialog } from '@/components/route-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useRouteOverlay } from '@/components/use-route-overlay';
import { createComputer } from '../api-computers.js';
import { cliInstallCommand, npKeys } from '../constants.js';
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

  return (
    <ol className='space-y-5'>
      <Step index={1} title={t('np.connect.install')}>
        <CommandLine command={cliInstallCommand(serverUrl)} />
      </Step>
      <Step index={2} title={t('np.connect.credential')}>
        <ComputerCredential serverUrl={serverUrl} />
      </Step>
      {/* NP-150: a boot service running the installed CLI, not a daemon started by hand. */}
      <Step
        index={3}
        title={t('np.connect.start')}
        hint={t('np.connect.startHint')}
      >
        <CommandLine command='nocoproject daemon install' />
      </Step>
      <li className='text-sm text-muted-foreground'>{t('np.connect.after')}</li>
    </ol>
  );
}

function Step({
  index,
  title,
  hint,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <li className='space-y-2'>
      <p className='text-sm font-medium'>
        {index}. {title}
      </p>
      {children}
      {hint ? <p className='text-xs text-muted-foreground'>{hint}</p> : null}
    </li>
  );
}

/**
 * Issues this computer's credential (NP-150) and shows the login command with it, once: the credential reaches only
 * the daemon API and can be revoked on its own, unlike a personal API key.
 */
function ComputerCredential({
  serverUrl,
}: {
  readonly serverUrl: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => createComputer(api, name.trim()),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.computers }),
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.connect.credentialFailed'),
      }),
  });

  if (create.data)
    return (
      <div className='space-y-2'>
        <CommandLine
          command={`nocoproject login --server ${serverUrl} --computer-key ${create.data.key}`}
        />
        <p className='text-xs text-muted-foreground'>
          {t('np.connect.credentialOnce', { name: create.data.computer.name })}
        </p>
      </div>
    );
  return (
    <form
      className='flex items-start gap-2'
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('np.connect.computerName')}
        aria-label={t('np.connect.computerName')}
        maxLength={255}
        className='flex-1'
      />
      <Button type='submit' disabled={!name.trim() || create.isPending}>
        {t('np.connect.issue')}
      </Button>
    </form>
  );
}

function ConnectFooter(): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return <Button onClick={() => void close()}>{t('np.connect.done')}</Button>;
}
