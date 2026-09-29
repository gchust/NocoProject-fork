import { useTranslation } from '@nocobase/i18n/client';
import { ChevronRight } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

/**
 * The document's place in the knowledge tree (NP-147): its ancestors, root first, then the document itself.
 * Renders nothing for a root document — the generic `Breadcrumbs` above it already says "Knowledge".
 */
export function KnowledgeAncestors({
  breadcrumbs,
  title,
}: {
  readonly breadcrumbs: readonly {
    readonly id: string;
    readonly title: string;
    readonly slug: string;
  }[];
  readonly title: string;
}): ReactElement | null {
  const { t } = useTranslation();
  if (breadcrumbs.length === 0) return null;
  return (
    <nav aria-label={t('np.knowledge.ancestors')}>
      <ol className='flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground'>
        {breadcrumbs.map((ancestor) => (
          <li key={ancestor.id} className='inline-flex items-center gap-1'>
            <Link
              to={`/knowledge/${encodeURIComponent(ancestor.id)}`}
              className='truncate transition-colors hover:text-foreground'
            >
              {ancestor.title}
            </Link>
            <ChevronRight className='size-3.5 shrink-0' aria-hidden='true' />
          </li>
        ))}
        <li aria-current='page' className='truncate text-foreground'>
          {title}
        </li>
      </ol>
    </nav>
  );
}
