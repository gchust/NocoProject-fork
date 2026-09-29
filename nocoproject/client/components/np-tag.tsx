import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { NP_TONE_CLASS, type NpTone } from '@/components/np-tones';
import { cn } from '@/lib/utils';

export type { NpTone } from '@/components/np-tones';

/**
 * The one tag of NocoProject (nocosolution/guidelines/NocoSolution 前端规范.md §5.3): a rounded pill in a light tint
 * of its hue with darker text of the same hue, 12px, tight enough that the pill hugs the glyph height instead of
 * the padding; a status adds a small leading dot. Status, priority, PR and run states, decision types and role tags
 * all use it, so they read as one family in both themes.
 */
export function NpTag({
  tone,
  dot = false,
  icon,
  children,
  className,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & {
  readonly tone: NpTone;
  /** A leading dot in the hue's saturated shade (status tags). */
  readonly dot?: boolean;
  /** A leading icon instead of the dot. */
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span
      data-slot='np-tag'
      data-tone={tone}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0 badge-text font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
        NP_TONE_CLASS[tone],
        className,
      )}
      {...props}
    >
      {icon ??
        (dot ? (
          <span
            aria-hidden='true'
            className='size-1.5 shrink-0 rounded-full bg-current'
          />
        ) : null)}
      {children}
    </span>
  );
}
