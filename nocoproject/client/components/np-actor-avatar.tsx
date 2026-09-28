import { useTranslation } from '@nocobase/i18n/client';
import { BotIcon, CogIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { initials } from '@/pages/np/format';

export type NpActorKind = 'user' | 'agent' | 'system' | 'none';

export interface NpActorAvatarProps {
  readonly type: NpActorKind;
  readonly name?: string | null;
  /** `xs` sits inline with text (16px), `sm` in lists (24px), `default` in headers (32px). */
  readonly size?: 'xs' | 'sm' | 'default';
  /** Renders the name beside the avatar. */
  readonly showName?: boolean;
  /**
   * An avatar next to a visible name is decorative (the default). A standalone avatar sets `false` and is announced
   * as "name (kind)".
   */
  readonly decorative?: boolean;
  /** A working agent: the avatar breathes with the primary color (nocosolution/frontend/nocosolution-frontend-standard.md §5.2). */
  readonly live?: boolean;
  readonly className?: string;
}

/**
 * The one avatar for people, agents and the system across NocoProject (§H 4, nocosolution/frontend/nocosolution-frontend-standard.md §5.1). Shape
 * and color both tell the kind apart: a person is a round avatar with initials, an agent a rounded square with a bot
 * in the agent hue, the system a dashed round cog. The kind is repeated as screen-reader text so it does not rest on
 * the picture alone.
 */
export function NpActorAvatar({
  type,
  name,
  size = 'sm',
  showName = false,
  decorative = true,
  live = false,
  className,
}: NpActorAvatarProps): ReactElement {
  const { t } = useTranslation();
  const label =
    type === 'agent'
      ? t('np.actor.agent')
      : type === 'system'
        ? t('np.actor.system')
        : t('np.actor.user');
  const icon =
    size === 'xs' ? 'size-2.5' : size === 'sm' ? 'size-3.5' : 'size-4';
  const avatar = (
    <Avatar
      size={size === 'default' ? 'default' : 'sm'}
      data-actor={type}
      data-live={live ? 'true' : undefined}
      className={cn(
        size === 'xs' && 'size-4',
        type === 'agent' && 'rounded-md after:rounded-md',
        type === 'system' &&
          'after:border-dashed after:border-muted-foreground/50',
        live && 'np-live-ring',
        !showName && className,
      )}
      {...(decorative || showName
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': `${name ?? '—'} (${label})` })}
      title={name ?? undefined}
    >
      <AvatarFallback
        className={cn(
          'font-medium text-foreground/80',
          size === 'xs' && 'text-[0.5rem]',
          type === 'agent' && 'rounded-md bg-agent/15 text-agent',
          type === 'system' && 'bg-transparent text-muted-foreground',
        )}
      >
        {type === 'agent' ? (
          <BotIcon className={icon} aria-hidden='true' />
        ) : type === 'system' ? (
          <CogIcon className={icon} aria-hidden='true' />
        ) : (
          <span aria-hidden='true'>{initials(name ?? '?')}</span>
        )}
      </AvatarFallback>
    </Avatar>
  );
  if (!showName) return avatar;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      {avatar}
      <span className='truncate'>{name ?? '—'}</span>
      <span className='sr-only'>{`(${label})`}</span>
    </span>
  );
}
