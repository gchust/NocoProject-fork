import { ApiClientError } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { AlertCircleIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The loading, empty and error states every NocoProject page shares (§H 2, 5), so a list, a card grid and a detail
 * page look the same while waiting, when empty and when a request fails.
 */

/** Rows shaped like a table while it loads. */
export function NpListSkeleton({
  rows = 6,
  className,
}: {
  readonly rows?: number;
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      role='status'
      aria-label={t('status.loading')}
      className={cn('space-y-2 rounded-lg border bg-card p-3', className)}
    >
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className='h-7 w-full' />
      ))}
    </div>
  );
}

/** A detail page's heading and blocks while it loads. */
export function NpDetailSkeleton(): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      role='status'
      aria-label={t('status.loading')}
      className='space-y-4 px-6 py-6 md:px-8'
    >
      <Skeleton className='h-4 w-40' />
      <Skeleton className='h-8 w-1/2' />
      <Skeleton className='h-24 w-full' />
      <Skeleton className='h-40 w-full' />
    </div>
  );
}

/** The localized sentence for a failed request: forbidden, not found, or a generic failure. */
function npErrorKey(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'np.common.forbidden';
    if (error.status === 404) return 'np.states.notFound';
  }
  return 'np.common.requestFailed';
}

/** A failed load with a retry button (none for 403, which retrying cannot fix). */
export function NpLoadError({
  title,
  error,
  onRetry,
  action,
}: {
  readonly title: string;
  readonly error: unknown;
  readonly onRetry?: () => void;
  /** Replaces the retry button, for example "back to the list" on a 404. */
  readonly action?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const forbidden = error instanceof ApiClientError && error.status === 403;
  return (
    <Alert variant='destructive'>
      <AlertCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{t(npErrorKey(error))}</AlertDescription>
      {action ? (
        <AlertAction>{action}</AlertAction>
      ) : onRetry && !forbidden ? (
        <AlertAction>
          <Button variant='outline' size='sm' onClick={onRetry}>
            {t('status.retry')}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

/** An empty list or panel: icon, title, one sentence and an optional action. */
export function NpEmpty({
  icon,
  title,
  description,
  action,
  className,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <Empty className={cn('border border-dashed bg-card/40', className)}>
      <EmptyHeader>
        <EmptyMedia variant='icon'>{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription>{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
