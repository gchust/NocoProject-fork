import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { BookOpenTextIcon, PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { NpSectionHeading } from '@/components/np-section';
import { NpEmpty, NpListSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';

import {
  fetchKnowledgeList,
  fetchKnowledgeProposals,
} from '../../api-knowledge.js';
import { npKeys } from '../../constants.js';
import { useNpFormatters } from '../../format.js';
import { KnowledgeProposalCard } from '../../knowledge/proposal-card.js';

/**
 * The Knowledge tab of a project (client/pages/np/README.md §3): the project's documents with "new document", and the
 * agents' pending proposals for this project, decidable in place.
 */
export function ProjectKnowledge({
  projectId,
}: {
  readonly projectId: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const format = useNpFormatters();
  const docs = useQuery({
    queryKey: npKeys.knowledgeList({ projectId }),
    queryFn: ({ signal }) => fetchKnowledgeList(api, { projectId }, signal),
  });
  const proposals = useQuery({
    queryKey: npKeys.knowledgeProposals,
    queryFn: ({ signal }) => fetchKnowledgeProposals(api, 'pending', signal),
  });
  const pending = (proposals.data ?? []).filter(
    (proposal) => proposal.projectId === projectId,
  );
  const newDoc = (
    <Button
      size='sm'
      nativeButton={false}
      render={
        <Link
          to={{
            pathname: '/knowledge/new',
            search: `?project=${encodeURIComponent(projectId)}`,
          }}
        />
      }
    >
      <PlusIcon data-icon='inline-start' />
      {t('np.knowledge.new')}
    </Button>
  );

  return (
    <div className='space-y-6'>
      {pending.length > 0 ? (
        <section className='space-y-3' aria-labelledby='np-project-proposals'>
          <NpSectionHeading
            id='np-project-proposals'
            title={t('np.projectPage.proposals')}
            count={pending.length}
          />
          <ul className='grid gap-3 lg:grid-cols-2'>
            {pending.map((proposal) => (
              <li key={proposal.id}>
                <KnowledgeProposalCard proposal={proposal} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className='space-y-3' aria-labelledby='np-project-docs'>
        <NpSectionHeading
          id='np-project-docs'
          title={t('np.projectPage.documents')}
          count={docs.data?.length}
          actions={newDoc}
        />
        {docs.isError && !docs.data ? (
          <NpLoadError
            title={t('np.knowledge.loadFailed')}
            error={docs.error}
            onRetry={() => void docs.refetch()}
          />
        ) : !docs.data ? (
          <NpListSkeleton rows={3} />
        ) : docs.data.length === 0 ? (
          <NpEmpty
            icon={<BookOpenTextIcon />}
            title={t('np.knowledge.emptyTitle')}
            description={t('np.projectPage.noDocuments')}
          />
        ) : (
          <ul className='divide-y overflow-hidden rounded-lg border bg-card'>
            {docs.data.map((doc) => (
              <li key={doc.id}>
                <Link
                  to={`/knowledge/${encodeURIComponent(doc.id)}`}
                  className='flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40'
                >
                  <BookOpenTextIcon
                    className='size-4 shrink-0 text-muted-foreground'
                    aria-hidden='true'
                  />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-sm font-medium'>
                      {doc.title}
                    </span>
                    {doc.summary ? (
                      <span className='block truncate text-xs text-muted-foreground'>
                        {doc.summary}
                      </span>
                    ) : null}
                  </span>
                  {doc.archivedAt ? (
                    <NpTag tone='slate'>{t('np.projectPage.archived')}</NpTag>
                  ) : null}
                  <span className='font-mono text-xs text-muted-foreground'>
                    v{doc.version}
                  </span>
                  <span className='w-24 shrink-0 text-right text-xs text-muted-foreground'>
                    {format.relative(doc.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
