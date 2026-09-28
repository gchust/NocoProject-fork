import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { NpMarkdown } from '@/components/np-markdown';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import {
  fetchKnowledgeDetail,
  fetchKnowledgeProposals,
} from '../api-knowledge.js';
import { npKeys } from '../constants.js';
import type { InboxItem } from '../types.js';
import { diffStats, foldDiff, lineDiff } from './line-diff.js';

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * What a knowledge proposal would change (nocosolution/frontend/nocosolution-frontend-standard.md §2): the agent's reason and summary, then the
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
                <ContentBlock content={proposal.content} />
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
          <ContentBlock content={proposal.content} />
        )
      ) : (
        <p className='text-sm text-muted-foreground'>
          {t('np.decision.knowledge.gone')}
        </p>
      )}
    </div>
  );
}

function ContentBlock({ content }: { readonly content: string }): ReactElement {
  return (
    <div className='max-h-96 overflow-y-auto rounded-md border bg-muted/40 px-4 py-3'>
      <NpMarkdown content={content} />
    </div>
  );
}

/** Added lines in green, removed lines in red and struck, long unchanged runs folded (§8.1). */
export function KnowledgeDiff({
  before,
  after,
}: {
  readonly before: string;
  readonly after: string;
}): ReactElement {
  const { t } = useTranslation();
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const blocks = useMemo(() => foldDiff(lines), [lines]);
  const stats = diffStats(lines);
  return (
    <figure className='overflow-hidden rounded-md border'>
      <figcaption className='flex items-center gap-3 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground'>
        <span className='text-success tabular-nums'>+{stats.added}</span>
        <span className='text-destructive tabular-nums'>−{stats.removed}</span>
        <span>{t('np.decision.knowledge.diffCaption')}</span>
      </figcaption>
      <div className='max-h-96 overflow-auto bg-card font-mono text-xs leading-5'>
        {stats.added === 0 && stats.removed === 0 ? (
          <p className='px-3 py-2 font-sans text-muted-foreground'>
            {t('np.decision.knowledge.noChange')}
          </p>
        ) : (
          blocks.map((block) =>
            block.kind === 'gap' ? (
              <div
                key={`gap-${block.n}`}
                className='border-y border-dashed bg-muted/30 px-3 py-0.5 font-sans text-muted-foreground'
              >
                {t('np.decision.knowledge.unchanged', { count: block.count })}
              </div>
            ) : (
              block.lines.map((line) => (
                <div
                  key={line.n}
                  data-diff={line.op}
                  className={cn(
                    'flex gap-2 px-3 whitespace-pre-wrap wrap-anywhere',
                    line.op === 'add' && 'bg-success/10',
                    line.op === 'del' &&
                      'bg-destructive/10 text-muted-foreground line-through',
                  )}
                >
                  <span
                    aria-hidden='true'
                    className={cn(
                      'w-3 shrink-0 select-none',
                      line.op === 'add' && 'text-success',
                      line.op === 'del' && 'text-destructive',
                    )}
                  >
                    {line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' '}
                  </span>
                  <span className='sr-only'>
                    {line.op === 'add'
                      ? t('np.decision.knowledge.added')
                      : line.op === 'del'
                        ? t('np.decision.knowledge.removed')
                        : ''}
                  </span>
                  <span className='min-w-0 flex-1'>{line.text || ' '}</span>
                </div>
              ))
            ),
          )
        )}
      </div>
    </figure>
  );
}
