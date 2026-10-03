import type { ReactElement, ReactNode } from 'react';

import { RuntimeTypeIcon } from '@/components/np-runtime-type';
import { useRuntimeTypeCopy } from '@/components/np-runtime-type-copy';

import type { RuntimeType } from '../types-runtime-types.js';

/**
 * One block of `/runtimes` (NP-219 §9.1): the type's runtime name as the heading, its one-line description, the
 * block's own action on the right, then its content.
 */
export function RuntimeTypeSection({
  type,
  actions,
  children,
}: {
  readonly type: RuntimeType;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const copy = useRuntimeTypeCopy()(type);
  const headingId = `np-runtimes-${type}`;
  return (
    <section
      aria-labelledby={headingId}
      data-runtime-type={type}
      className='space-y-3'
    >
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0 space-y-1'>
          <h2
            id={headingId}
            className='flex items-center gap-2 font-heading text-base font-semibold'
          >
            <RuntimeTypeIcon
              type={type}
              className='size-4 shrink-0 text-muted-foreground'
            />
            {copy.runtimeName}
          </h2>
          <p className='text-sm text-muted-foreground'>{copy.summary}</p>
        </div>
        {actions ? (
          <div className='flex shrink-0 items-center gap-2'>{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
