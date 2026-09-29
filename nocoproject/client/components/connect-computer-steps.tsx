import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, type ReactNode, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { createComputer } from '@/pages/np/api-computers';
import { cliInstallCommand, npKeys } from '@/pages/np/constants';
import { CommandLine } from '@/pages/np/runtimes/command-line';
import { useServerUrl } from '@/pages/np/runtimes/use-server-url';

/**
 * The steps that connect a computer's coding tools to this application (NP-150): install the CLI, issue that
 * computer's credential and sign in, install the boot service. Shared by the `/runtimes/connect` dialog and the
 * `/profile` "My computer" section (NP-153).
 */
export function ConnectComputerSteps(): ReactElement {
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
