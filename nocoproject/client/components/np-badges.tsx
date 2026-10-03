import { useTranslation } from '@nocobase/i18n/client';
import { AlertTriangleIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { RuntimeTypeTag } from '@/components/np-runtime-type';
import { NpTag } from '@/components/np-tag';
import type { NpTone } from '@/components/np-tones';
import { cn } from '@/lib/utils';
import {
  PRIORITY_TONE,
  statusLabelKey,
  statusTone,
} from '@/pages/np/constants';
import {
  runtimeTypeOf,
  type RuntimeType,
} from '@/pages/np/types-runtime-types';
import type {
  ExecutorType,
  IssuePriority,
  RunStatus,
  StatusCatalogEntry,
} from '@/pages/np/types';

/** An issue status: a tag with a dot in the status's tone (nocosolution/guidelines/frontend-standard.md §S7.1) and its name. */
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
 * red, cancelled slate, waiting grey (nocosolution/guidelines/frontend-standard.md §S7.2).
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

/**
 * Online/offline as a tag: online is green with a solid dot, offline grey with a hollow ring, so the two differ in
 * hue, fill and shape and the word keeps the state readable without colour (NP-165).
 */
export function NpOnlineState({
  online,
  className,
  title,
}: {
  readonly online: boolean;
  readonly className?: string;
  /** Why it is offline, on hover. */
  readonly title?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <NpTag
      tone={online ? 'green' : 'grey'}
      data-online={online ? 'true' : 'false'}
      title={title}
      className={className}
      icon={
        <span
          aria-hidden='true'
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            online ? 'bg-current' : 'border border-current',
          )}
        />
      }
    >
      {online ? t('np.common.online') : t('np.common.offline')}
    </NpTag>
  );
}

/**
 * Who executes an issue: a person, an agent (with its type tag, NP-219), or nobody. The tag is the icon alone (name and
 * description on hover) unless `typeName` gives it room; an executor is a computer agent unless `runtimeType` says
 * otherwise (the server refuses built-in executors). An agent with active runs shows a
 * pulsing "Working" indicator. A long name truncates to the space it is given (the markers keep their width) and the
 * full name shows on hover.
 */
export function NpExecutor({
  type,
  name,
  activeRunCount = 0,
  runtimeType,
  typeName = false,
}: {
  readonly type: ExecutorType;
  readonly name?: string | null;
  readonly activeRunCount?: number;
  readonly runtimeType?: RuntimeType;
  /** Show the type's name beside its icon. */
  readonly typeName?: boolean;
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
      {type === 'agent' ? (
        <RuntimeTypeTag
          type={runtimeTypeOf({ runtimeType })}
          iconOnly={!typeName}
          className='shrink-0'
        />
      ) : null}
      {working ? (
        <span className='inline-flex shrink-0 items-center gap-1 text-xs text-primary'>
          <NpPulse />
          {t('np.executor.working')}
        </span>
      ) : null}
    </span>
  );
}
