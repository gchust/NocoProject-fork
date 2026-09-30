import { useTranslation } from '@nocobase/i18n/client';
import { MonitorIcon, MonitorOffIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpOnlineState } from '@/components/np-badges';
import { NpTag } from '@/components/np-tag';

import type { ComputerGroup } from './computer-groups.js';

/**
 * A group header row (NP-188): the computer's name and device, whether any of its runtimes is online, a count, its
 * owner; `extra` sits before the owner (the runtimes page puts the daemon's CLI there). `group` null = no computer.
 */
export function ComputerGroupHeader({
  group,
  count,
  extra,
}: {
  readonly group: ComputerGroup | null;
  readonly count: string;
  readonly extra?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  if (!group)
    return (
      <div className='flex min-w-0 items-center gap-2 text-sm'>
        <MonitorOffIcon className='size-4 shrink-0 text-muted-foreground' />
        <span className='font-medium text-muted-foreground'>
          {t('np.computers.group.none')}
        </span>
        <span className='text-xs text-muted-foreground'>{count}</span>
      </div>
    );
  return (
    <div className='flex min-w-0 items-center gap-2 text-sm'>
      <MonitorIcon className='size-4 shrink-0 text-muted-foreground' />
      <span className='truncate font-medium' title={group.name}>
        {group.name}
      </span>
      {group.deviceName && group.deviceName !== group.name ? (
        <span className='truncate text-xs text-muted-foreground'>
          {group.deviceName}
        </span>
      ) : null}
      {group.revoked ? (
        <NpTag tone='grey'>{t('np.computers.state.revoked')}</NpTag>
      ) : group.onlineCount === 0 &&
        group.runtimes.some(
          (runtime) => runtime.status === 'upgrade_required',
        ) ? (
        // NP-150: a daemon that must be upgraded is alive, never "offline".
        <NpTag tone='amber' dot>
          {t('np.runtimes.upgrade.required')}
        </NpTag>
      ) : (
        <NpOnlineState online={group.onlineCount > 0} />
      )}
      <span className='text-xs whitespace-nowrap text-muted-foreground'>
        {count}
      </span>
      <div className='ml-auto flex shrink-0 items-center gap-3'>
        {extra}
        {group.ownerName ? (
          <NpActorAvatar
            type='user'
            name={group.ownerName}
            size='xs'
            showName
            className='text-sm'
          />
        ) : null}
      </div>
    </div>
  );
}
