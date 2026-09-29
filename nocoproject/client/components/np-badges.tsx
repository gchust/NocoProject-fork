import { useTranslation } from '@nocobase/i18n/client';
import { AlertTriangleIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpTag } from '@/components/np-tag';
import type { NpTone } from '@/components/np-tones';
import { cn } from '@/lib/utils';
import {
  PRIORITY_TONE,
  statusLabelKey,
  statusTone,
} from '@/pages/np/constants';
import type {
  ExecutorType,
  IssuePriority,
  RunStatus,
  StatusCatalogEntry,
} from '@/pages/np/types';

/** An issue status: a tag with a dot in the status's tone (nocosolution/frontend/nocosolution-frontend-standard.md §7.1) and its name. */
export function NpStatusBadge({
  statusKey,
  catalog,
  className,
}: {
  readonly statusKey: string;
  readonly catalog?: readonly StatusCatalogEntry[];
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <NpTag
      tone={statusTone(statusKey, catalog)}
      dot
      data-status={statusKey}
      className={className}
    >
      {t(statusLabelKey(statusKey), { defaultValue: statusKey })}
    </NpTag>
  );
}

/**
 * A run's status as a tag: running work in blue with a pulse (the "happening now" signal), success green, failure
 * red, cancelled slate, waiting grey (nocosolution/frontend/nocosolution-frontend-standard.md §7.2).
 */
export function NpRunStatusBadge({
  status,
}: {
  readonly status: RunStatus;
}): ReactElement {
  const { t } = useTranslation();
  const active =
    status === 'running' || status === 'dispatched' || status === 'queued';
  const tone: NpTone =
    status === 'running' || status === 'dispatched'
      ? 'blue'
      : status === 'completed'
        ? 'green'
        : status === 'failed'
          ? 'red'
          : status === 'cancelled'
            ? 'slate'
            : 'grey';
  return (
    <NpTag
      tone={tone}
      dot={!active}
      icon={active ? <NpPulse inherit /> : undefined}
      data-run-status={status}
    >
      {t(`np.runStatus.${status}`)}
    </NpTag>
  );
}

/**
 * A priority: a tag (urgent red, high orange, medium blue, low grey, §2.4); no priority is a muted dash (the word
 * stays for screen readers), so the tags that do show stand out.
 */
export function NpPriorityLabel({
  priority,
  className,
}: {
  readonly priority: IssuePriority;
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  if (priority === 'none') {
    return (
      <span className={cn('text-sm text-muted-foreground', className)}>
        —<span className='sr-only'>{t('np.priority.none')}</span>
      </span>
    );
  }
  return (
    <NpTag
      tone={PRIORITY_TONE[priority]}
      data-priority={priority}
      className={className}
      icon={
        priority === 'urgent' ? <AlertTriangleIcon aria-hidden='true' /> : null
      }
    >
      {t(`np.priority.${priority}`)}
    </NpTag>
  );
}

/** A small pulsing dot marking work in progress; decorative, the surrounding text carries the meaning. */
export function NpPulse({
  className,
  inherit = false,
}: {
  readonly className?: string;
  /** Pulse in the surrounding text colour (inside a tag) instead of the primary colour. */
  readonly inherit?: boolean;
}): ReactElement {
  const fill = inherit ? 'bg-current' : 'bg-primary';
  return (
    <span
      className={cn('relative flex size-2 shrink-0', className)}
      aria-hidden='true'
    >
      <span
        className={cn(
          'absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none',
          fill,
        )}
      />
      <span className={cn('relative inline-flex size-2 rounded-full', fill)} />
    </span>
  );
}

/** Online/offline with a dot and a word, so the state is not carried by color alone. */
export function NpOnlineState({
  online,
}: {
  readonly online: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span className='inline-flex items-center gap-1.5 text-sm'>
      <span
        aria-hidden='true'
        className={cn(
          'size-2 shrink-0 rounded-full',
          online ? 'bg-success' : 'bg-muted-foreground/40',
        )}
      />
      <span className={online ? undefined : 'text-muted-foreground'}>
        {online ? t('np.common.online') : t('np.common.offline')}
      </span>
    </span>
  );
}

/**
 * Who executes an issue: a person, an agent (with an "Agent" marker), or nobody. An agent with active runs shows a
 * pulsing "Working" indicator. A long name truncates to the space it is given (the markers keep their width) and the
 * full name shows on hover.
 */
export function NpExecutor({
  type,
  name,
  activeRunCount = 0,
}: {
  readonly type: ExecutorType;
  readonly name?: string | null;
  readonly activeRunCount?: number;
}): ReactElement {
  const { t } = useTranslation();
  if (type === 'none' || !name) {
    return (
      <span className='text-sm text-muted-foreground'>
        —
        {type === 'none' ? (
          <span className='sr-only'>{t('np.executor.none')}</span>
        ) : null}
      </span>
    );
  }
  const working = type === 'agent' && activeRunCount > 0;
  return (
    <span
      className='inline-flex max-w-full min-w-0 items-center gap-1.5 text-sm'
      title={name}
    >
      <NpActorAvatar type={type} name={name} size='xs' live={working} />
      <span className='truncate'>{name}</span>
      {type === 'agent' && !working ? (
        <span className='shrink-0 text-xs text-agent'>
          {t('np.executor.agentMarker')}
        </span>
      ) : null}
      {working ? (
        <span className='inline-flex shrink-0 items-center gap-1 text-xs text-primary'>
          <span className='sr-only'>{t('np.executor.agentMarker')}</span>
          <NpPulse />
          {t('np.executor.working')}
        </span>
      ) : null}
    </span>
  );
}
