import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import type { TocHeading } from '@/components/np-markdown-toc';
import { cn } from '@/lib/utils';

function scrollToHeading(id: string): void {
  document.getElementById(id)?.scrollIntoView?.({
    behavior: 'smooth',
    block: 'start',
  });
}

/**
 * A table of contents for the document body, from its `h1`–`h3` headings (§3); renders nothing under 3 headings.
 * Shown twice by the caller: pinned in the side column from `lg` up, and above the body on narrow screens.
 */
export function KnowledgeToc({
  headings,
  className,
}: {
  readonly headings: readonly TocHeading[];
  readonly className?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  if (headings.length < 3) return null;
  return (
    <nav
      aria-label={t('np.knowledge.toc')}
      className={cn('space-y-2', className)}
    >
      <h2 className='text-sm font-semibold'>{t('np.knowledge.toc')}</h2>
      <ul className='space-y-0.5 text-sm'>
        {headings.map((heading) => (
          <li
            key={heading.id}
            style={{ paddingLeft: `${(heading.level - 1) * 0.75}rem` }}
          >
            <button
              type='button'
              onClick={() => scrollToHeading(heading.id)}
              className='block w-full truncate text-left text-muted-foreground hover:text-foreground hover:underline'
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
