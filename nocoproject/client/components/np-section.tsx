import type { ReactElement, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The heading of a block inside a page (nocosolution/guidelines/frontend-standard.md §3.4): a small semibold title, an optional count and
 * one-line description, and the block's actions on the right. Every card and section on a detail page starts with
 * one, so blocks line up.
 */
export function NpSectionHeading({
  id,
  title,
  count,
  description,
  actions,
  className,
}: {
  readonly id?: string;
  readonly title: ReactNode;
  readonly count?: number;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className='min-w-0'>
        <h2
          id={id}
          className='flex items-center gap-2 font-heading text-sm font-semibold'
        >
          {title}
          {count !== undefined ? (
            <span className='text-xs font-normal text-muted-foreground tabular-nums'>
              {count}
            </span>
          ) : null}
        </h2>
        {description ? (
          <p className='mt-0.5 text-sm text-muted-foreground'>{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className='flex shrink-0 items-center gap-1'>{actions}</div>
      ) : null}
    </div>
  );
}
