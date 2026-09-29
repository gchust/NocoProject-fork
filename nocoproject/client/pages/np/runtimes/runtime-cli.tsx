import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { NpOnlineState } from '@/components/np-badges';
import { NpTag } from '@/components/np-tag';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';

import { CLI_VERSION } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { Runtime } from '../types.js';
import { CommandLine } from './command-line.js';
import { useServerUrl } from './use-server-url.js';
import {
  runtimeCliState,
  runtimeCliVersion,
  upgradeCommand,
} from './daemon-version.js';

/** The status column (NP-150): a daemon that must be upgraded shows that, never "offline". */
export function RuntimeStatusCell({
  runtime,
}: {
  readonly runtime: Runtime;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  if (runtime.status !== 'upgrade_required')
    return <NpOnlineState online={runtime.status === 'online'} />;
  return (
    <NpTag
      tone='amber'
      dot
      title={t('np.runtimes.upgrade.lastSeen', {
        time: format.relative(runtime.lastSeenAt),
      })}
    >
      {t('np.runtimes.upgrade.required')}
    </NpTag>
  );
}

/**
 * The CLI column (NP-150): the daemon's version, amber when it is behind what this application serves or must be
 * upgraded; clicking it shows the command that upgrades that computer.
 */
export function RuntimeCliCell({
  runtime,
}: {
  readonly runtime: Runtime;
}): ReactElement {
  const { t } = useTranslation();
  // NP-150: a daemon still signing in with its owner's personal API key is flagged next to its version.
  if (runtime.daemon?.credential === 'personalKey')
    return (
      <span className='inline-flex items-center gap-1.5'>
        <RuntimeCliVersion runtime={runtime} />
        <NpTag tone='amber' title={t('np.runtimes.personalKeyHint')}>
          {t('np.runtimes.personalKey')}
        </NpTag>
      </span>
    );
  return <RuntimeCliVersion runtime={runtime} />;
}

function RuntimeCliVersion({
  runtime,
}: {
  readonly runtime: Runtime;
}): ReactElement {
  const { t } = useTranslation();
  const serverUrl = useServerUrl();
  const version = runtimeCliVersion(runtime);
  const state = runtimeCliState(runtime);
  if (state === 'unknown')
    return <span className='text-muted-foreground'>—</span>;
  if (state === 'current')
    return <span className='font-mono text-xs'>{version}</span>;
  const required = state === 'required';
  const device = runtime.deviceInfo?.deviceName;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type='button'
            className='cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring'
            aria-label={t('np.runtimes.upgrade.show')}
          />
        }
      >
        <NpTag tone='amber' className='font-mono'>
          {version ?? '—'}
        </NpTag>
      </PopoverTrigger>
      <PopoverContent className='w-96' align='start'>
        <PopoverHeader>
          <PopoverTitle>
            {t(
              required
                ? 'np.runtimes.upgrade.requiredTitle'
                : 'np.runtimes.upgrade.availableTitle',
              {
                device:
                  typeof device === 'string' && device ? device : runtime.name,
              },
            )}
          </PopoverTitle>
          <PopoverDescription>
            {t('np.runtimes.upgrade.versions', {
              current: version ?? '—',
              latest: runtime.daemon?.latestVersion ?? CLI_VERSION,
            })}
          </PopoverDescription>
        </PopoverHeader>
        <CommandLine command={upgradeCommand(serverUrl, version)} />
        <p className='text-xs text-muted-foreground'>
          {t('np.runtimes.upgrade.hint')}
        </p>
      </PopoverContent>
    </Popover>
  );
}
