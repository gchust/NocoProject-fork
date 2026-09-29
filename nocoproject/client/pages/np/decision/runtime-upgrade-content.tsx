import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { CommandLine } from '../runtimes/command-line.js';
import { useServerUrl } from '../runtimes/use-server-url.js';
import { upgradeCommand } from '../runtimes/daemon-version.js';
import type { InboxItem } from '../types.js';

/** `runtime_upgrade_required` (NP-150): the command that upgrades the computer the card is about. */
export function RuntimeUpgradeContent({
  item,
}: {
  readonly item: InboxItem;
}): ReactElement {
  const { t } = useTranslation();
  const serverUrl = useServerUrl();
  const version = item.payload?.daemonVersion;
  return (
    <section className='space-y-2'>
      <CommandLine
        command={upgradeCommand(
          serverUrl,
          typeof version === 'string' ? version : null,
        )}
      />
      <p className='text-xs text-muted-foreground'>
        {t('np.runtimes.upgrade.hint')}
      </p>
    </section>
  );
}
