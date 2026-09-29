import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { FileTextIcon, PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';

import { fetchKnowledgeList } from '../../api-knowledge.js';
import { npKeys } from '../../constants.js';
import type { KnowledgeDoc } from '../../types-iter3.js';
import { knowledgeChildren } from '../knowledge-model.js';

/**
 * The document's direct children (NP-147), with "New sub-document" pre-filling `parentId`. Empty, the section folds
 * into one dashed row like the issue page's sub-issues (`client/pages/np/issues/detail/subtasks-section.tsx`).
 */
export function KnowledgeSubDocuments({
  doc,
}: {
  readonly doc: KnowledgeDoc;
}): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const filters = { projectId: doc.projectId ?? 'none' };
  const list = useQuery({
    queryKey: npKeys.knowledgeList(filters),
    queryFn: ({ signal }) => fetchKnowledgeList(api, filters, signal),
  });
  if (!list.data) return null;
  const children = knowledgeChildren(list.data, doc.id);
  const empty = children.length === 0;
  const newDocSearch = `?project=${encodeURIComponent(doc.projectId ?? 'workspace')}&parent=${encodeURIComponent(doc.id)}`;
  const newButton = (
    <Button
      variant='ghost'
      size='sm'
      nativeButton={false}
      render={
        <Link to={{ pathname: '/knowledge/new', search: newDocSearch }} />
      }
    >
      <PlusIcon data-icon='inline-start' />
      {t('np.knowledge.subDocuments.new')}
    </Button>
  );

  return (
    <section
      className={
        empty
          ? 'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-4 py-2'
          : 'space-y-3'
      }
      aria-labelledby='np-knowledge-subdocs'
    >
      <div
        className={
          empty ? 'contents' : 'flex items-center justify-between gap-2'
        }
      >
        <h2
          id='np-knowledge-subdocs'
          className={
            empty
              ? 'font-heading text-sm font-medium text-muted-foreground'
              : 'font-heading text-sm font-semibold'
          }
        >
          {t('np.knowledge.subDocuments.title')}
          {empty ? (
            <span className='ml-2 font-normal'>· {t('np.issueAdd.none')}</span>
          ) : (
            <span className='ml-2 text-xs font-normal text-muted-foreground tabular-nums'>
              {children.length}
            </span>
          )}
        </h2>
        {newButton}
      </div>
      {empty ? null : (
        <ul className='divide-y overflow-hidden rounded-lg border bg-card'>
          {children.map((child) => (
            <li key={child.id}>
              <Link
                to={`/knowledge/${encodeURIComponent(child.id)}`}
                className='flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40'
              >
                <FileTextIcon
                  className='size-4 shrink-0 text-muted-foreground'
                  aria-hidden='true'
                />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-sm font-medium'>
                    {child.title}
                  </span>
                  {child.summary ? (
                    <span className='block truncate text-xs text-muted-foreground'>
                      {child.summary}
                    </span>
                  ) : null}
                </span>
                {child.archivedAt ? (
                  <NpTag tone='slate'>{t('np.knowledge.archived')}</NpTag>
                ) : null}
                {(child.childCount ?? 0) > 0 ? (
                  <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>
                    {child.childCount}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
