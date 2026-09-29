import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { BookOpenTextIcon, PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { NpSectionHeading } from '@/components/np-section';
import { NpEmpty, NpListSkeleton, NpLoadError } from '@/components/np-states';
import { Button } from '@/components/ui/button';

import {
  fetchKnowledgeList,
  fetchKnowledgeProposals,
} from '../../api-knowledge.js';
import { npKeys } from '../../constants.js';
import { KnowledgeTree } from '../../knowledge/knowledge-tree.js';
import { KnowledgePendingProposals } from '../../knowledge/pending-proposals.js';

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
      <KnowledgePendingProposals proposals={pending} />
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
          <div className='rounded-lg border bg-card p-2'>
            <KnowledgeTree docs={docs.data} />
          </div>
        )}
      </section>
    </div>
  );
}
