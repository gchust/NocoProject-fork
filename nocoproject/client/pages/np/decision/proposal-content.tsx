import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpMarkdown } from '@/components/np-markdown';
import { Skeleton } from '@/components/ui/skeleton';

import { latestProposalComment } from '../api-iter4.js';
import { useNpFormatters } from '../format.js';
import { NpCommentTag } from '../issues/process-fields.js';
import type { InboxItem, IssueDetail } from '../types.js';

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The design proposal being reviewed (iteration 4 §B `design_review`), in full: the proposal comment the decision
 * names (`payload.proposalCommentId`), else the newest `kind: 'proposal'` comment on the issue, rendered as Markdown
 * with its author. Until the issue loads, or when the proposal is not on it, the payload's summary stands in.
 */
export function DesignProposalContent({
  item,
  detail,
  loading,
}: {
  readonly item: InboxItem;
  readonly detail: IssueDetail | undefined;
  readonly loading: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const payload = item.payload ?? {};
  const comment = latestProposalComment(
    detail,
    text(payload.proposalCommentId) ?? text(payload.commentId),
  );
  if (!comment && !detail && loading) {
    return (
      <div className='space-y-2'>
        <Skeleton className='h-4 w-40' />
        <Skeleton className='h-40 w-full' />
      </div>
    );
  }
  if (!comment) {
    const summary = text(payload.summary);
    return (
      <div className='space-y-2' data-proposal-summary>
        {summary ? (
          <div className='rounded-md border bg-muted/40 px-4 py-3'>
            <p className='mb-1 text-xs text-muted-foreground'>
              {t('np.proposal.summary')}
            </p>
            <NpMarkdown content={summary} />
          </div>
        ) : null}
        <p className='text-sm text-muted-foreground'>
          {t('np.proposal.missing')}
        </p>
      </div>
    );
  }
  const author =
    comment.authorName ?? item.actorName ?? t('np.common.unknownAgent');
  return (
    <article className='space-y-2' data-proposal-comment={comment.id}>
      <header className='flex flex-wrap items-center gap-2 text-sm'>
        <NpActorAvatar type={comment.authorType} name={author} size='xs' />
        <span className='font-medium'>{author}</span>
        <NpCommentTag tag='proposal' />
        <time
          className='ml-auto text-xs text-muted-foreground'
          dateTime={comment.createdAt}
          title={format.dateTime(comment.createdAt)}
        >
          {format.relative(comment.createdAt)}
        </time>
      </header>
      <div className='rounded-md border bg-muted/40 px-4 py-3'>
        <NpMarkdown content={comment.content} />
      </div>
    </article>
  );
}
