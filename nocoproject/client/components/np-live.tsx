import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, useEffect, useState } from 'react';
import { Link, type To } from 'react-router';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { cn } from '@/lib/utils';

/** Minutes since `iso`, refreshed every 30 seconds while mounted. */
function useMinutesSince(iso: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [iso]);
  if (!iso) return null;
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.floor((now - started) / 60_000));
}

/**
 * "Who is acting now" (nocosolution/guidelines/NocoSolution 前端规范.md §S5.2): the working agent's avatar breathing in the primary color,
 * its name and how long the run has been going. `queued` runs say they are waiting instead. Links to the run's
 * transcript when `to` is given.
 */
export function NpLiveRun({
  agentName,
  status,
  since,
  to,
  className,
}: {
  readonly agentName: string;
  readonly status: 'queued' | 'dispatched' | 'running' | 'deferred';
  readonly since?: string | null;
  readonly to?: To;
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  const minutes = useMinutesSince(since);
  const waiting = status === 'queued' || status === 'deferred';
  const text = waiting
    ? t('np.live.queued', { name: agentName })
    : minutes === null
      ? t('np.live.working', { name: agentName })
      : t('np.live.workingFor', { name: agentName, minutes });
  const body = (
    <>
      <NpActorAvatar type='agent' name={agentName} size='xs' live={!waiting} />
      <span className='truncate'>{text}</span>
    </>
  );
  const classes = cn(
    'inline-flex max-w-full min-w-0 items-center gap-2 rounded-full border bg-card py-0.5 pr-2.5 pl-1 text-xs',
    waiting ? 'text-muted-foreground' : 'border-primary/30 text-primary',
    className,
  );
  return to ? (
    <Link
      to={to}
      className={cn(
        classes,
        'transition-colors hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
      )}
      data-testid='np-live-run'
    >
      {body}
    </Link>
  ) : (
    <span className={classes} data-testid='np-live-run'>
      {body}
    </span>
  );
}

/**
 * A progress ring (client/pages/np/README.md §3): the done share as a primary arc on a muted track, the percentage
 * inside when there is room. Decorative when a label beside it says the same.
 */
export function NpProgressRing({
  percent,
  size = 40,
  label,
  showValue = true,
  className,
}: {
  readonly percent: number;
  /** Pixel size; a fixed size on purpose, like an icon (nocosolution/guidelines/NocoSolution 前端规范.md §4). */
  readonly size?: number;
  readonly label?: string;
  readonly showValue?: boolean;
  readonly className?: string;
}): ReactElement {
  const value = Math.min(100, Math.max(0, Math.round(percent)));
  const stroke = size >= 32 ? 3.5 : 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center',
        className,
      )}
      style={{ width: size, height: size }}
      {...(label
        ? {
            role: 'img',
            'aria-label': label,
          }
        : { 'aria-hidden': true })}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill='none'
          strokeWidth={stroke}
          className='stroke-muted'
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill='none'
          strokeWidth={stroke}
          strokeLinecap='round'
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - value / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className={cn(
            'transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none',
            value >= 100 ? 'stroke-success' : 'stroke-primary',
          )}
        />
      </svg>
      {showValue && size >= 32 ? (
        // The number alone: "100%" does not fit a 48px ring at 12px; the label says it is a percentage.
        <span className='absolute text-xs font-medium tracking-tight tabular-nums'>
          {value}
        </span>
      ) : null}
    </span>
  );
}
