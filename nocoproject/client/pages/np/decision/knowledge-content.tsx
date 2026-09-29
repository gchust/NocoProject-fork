import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';

import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import {
  fetchKnowledgeDetail,
  fetchKnowledgeProposals,
} from '../api-knowledge.js';
import { npKeys } from '../constants.js';
import {
  KnowledgeContentBlock,
  KnowledgeDiff,
} from '../knowledge/knowledge-diff.js';
import type { InboxItem } from '../types.js';

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * What a knowledge proposal would change (nocosolution/frontend/frontend-standard.md §S2): the agent's reason and summary, then the
 * proposed text — as a line diff against the current version for an update, in full for a new document. The
 * proposal comes from the pending list (the inbox payload carries only its id); once decided it is gone from that
 * list and the reason from the payload is all that is left to show.
 */
export function KnowledgeProposalContent({
  item,
}: {
  readonly item: InboxItem;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const payload = item.payload ?? {};
  const proposalId = text(payload.proposalId);
  const docId = text(payload.docId);
  const proposals = useQuery({
    queryKey: npKeys.knowledgeProposals,
    queryFn: ({ signal }) => fetchKnowledgeProposals(api, 'pending', signal),
    enabled: proposalId !== null,
  });
  const proposal = proposals.data?.find((entry) => entry.id === proposalId);
  const doc = useQuery({
    queryKey: npKeys.knowledgeDoc(docId ?? ''),
    queryFn: ({ signal }) => fetchKnowledgeDetail(api, docId ?? '', signal),
    enabled: docId !== null && proposal !== undefined,
  });
  const [full, setFull] = useState(false);
  const reason = proposal?.reason ?? text(payload.reason);
  const summary = proposal?.summary ?? text(payload.summary);
  const title =
    proposal?.docTitle || proposal?.title || text(payload.docTitle) || '';

  return (
    <div className='space-y-3'>
      <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm'>
        <dt className='text-muted-foreground'>
          {t('np.decision.knowledge.document')}
        </dt>
        <dd className='flex min-w-0 items-center gap-2'>
          {docId ? (
            <Link
              to={`/knowledge/${encodeURIComponent(docId)}`}
              className='truncate font-medium hover:underline'
            >
              {title}
            </Link>
          ) : (
            <span className='truncate font-medium'>{title}</span>
          )}
          {docId ? null : (
            <NpTag tone='blue'>{t('np.knowledge.proposals.new')}</NpTag>
          )}
        </dd>
        {reason ? (
          <>
            <dt className='text-muted-foreground'>
              {t('np.decision.knowledge.reason')}
            </dt>
            <dd className='wrap-anywhere'>{reason}</dd>
          </>
        ) : null}
        {summary ? (
          <>
            <dt className='text-muted-foreground'>
              {t('np.decision.knowledge.summary')}
            </dt>
            <dd className='wrap-anywhere'>{summary}</dd>
          </>
        ) : null}
      </dl>
      {proposalId && proposals.isPending ? (
        <Skeleton className='h-32 w-full' />
      ) : proposal ? (
        docId ? (
          doc.data ? (
            <div className='space-y-2'>
              <div className='flex items-center justify-between gap-2'>
                <p className='text-xs text-muted-foreground'>
                  {t('np.decision.knowledge.against', {
                    version: doc.data.doc.version,
                  })}
                </p>
                <Button
                  variant='ghost'
                  size='xs'
                  onClick={() => setFull((value) => !value)}
                >
                  {full
                    ? t('np.decision.knowledge.showDiff')
                    : t('np.decision.knowledge.showFull')}
                </Button>
              </div>
              {full ? (
                <KnowledgeContentBlock content={proposal.content} />
              ) : (
                <KnowledgeDiff
                  before={doc.data.doc.content}
                  after={proposal.content}
                />
              )}
            </div>
          ) : (
            <Skeleton className='h-32 w-full' />
          )
        ) : (
          <KnowledgeContentBlock content={proposal.content} />
        )
      ) : (
        <p className='text-sm text-muted-foreground'>
          {t('np.decision.knowledge.gone')}
        </p>
      )}
    </div>
  );
}
