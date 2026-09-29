import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ReplyIcon,
  RotateCcwIcon,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpMarkdown } from '@/components/np-markdown';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { setThreadResolved } from '../../api-iter2.js';
import type { CommentTag } from '../../api-iter4.js';
import { useNpFormatters } from '../../format.js';
import type { CommentThread, IssueComment } from '../../types.js';
import { NpCommentTag } from '../process-fields.js';
import { CommentReactions } from './comment-reactions.js';
import { commentSnippet } from './timeline.js';
import { useDetailMutation } from './use-detail-mutation.js';

export interface ThreadContext {
  readonly issueId: string;
  readonly meUserId: string | undefined;
  readonly agentName: (agentId: string | null | undefined) => string | null;
  readonly userName: (userId: string) => string;
  readonly replyingToId: string | null;
  readonly onReply: (comment: IssueComment) => void;
  /** Iteration 4: the "Proposal" / "Retrospective" tag of a proposal or retrospective comment. */
  readonly commentTag?: (comment: IssueComment) => CommentTag;
}

function authorLabel(
  comment: IssueComment,
  agentName: ThreadContext['agentName'],
  fallback: string,
): string {
  return (
    comment.authorName ??
    (comment.authorType === 'agent' ? agentName(comment.authorId) : null) ??
    fallback
  );
}

/**
 * A comment thread: the root comment and its replies (flattened, oldest first). A resolved thread (iteration 2 §F)
 * collapses to one line with a "resolved" chip and can be expanded or reopened; open threads offer "resolve" on the
 * root. Every comment carries its reactions.
 */
export function ThreadCard({
  thread,
  context,
}: {
  readonly thread: CommentThread;
  readonly context: ThreadContext;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const resolved = Boolean(thread.root.resolvedAt);
  const [expanded, setExpanded] = useState(false);
  const resolve = useDetailMutation(context.issueId, (next: boolean) =>
    setThreadResolved(api, thread.root.id, next),
  );

  if (thread.root.kind === 'system' && thread.replies.length === 0) {
    return <SystemComment comment={thread.root} />;
  }

  const name = authorLabel(
    thread.root,
    context.agentName,
    t('np.common.unknown'),
  );

  if (resolved && !expanded) {
    return (
      <article
        className='flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground'
        data-testid='np-thread-resolved'
      >
        <Button
          variant='ghost'
          size='icon-xs'
          aria-expanded={false}
          aria-label={t('np.threads.expand', { name })}
          onClick={() => setExpanded(true)}
        >
          <ChevronRightIcon />
        </Button>
        <NpTag tone='green' icon={<CheckCircle2Icon aria-hidden='true' />}>
          {t('np.threads.resolved')}
        </NpTag>
        <span className='shrink-0 font-medium text-foreground'>{name}</span>
        <span className='min-w-0 flex-1 truncate'>
          {commentSnippet(thread.root.content)}
        </span>
        {thread.replies.length > 0 ? (
          <span className='shrink-0 text-xs tabular-nums'>
            {t('np.threads.replies', { count: thread.replies.length })}
          </span>
        ) : null}
      </article>
    );
  }

  // A design proposal (iteration 4 §B) reads as a document: the same card, its border in the accent tint.
  const proposal = thread.root.kind === 'proposal';
  return (
    <article
      className={cn(
        'rounded-lg border bg-card text-card-foreground',
        proposal && 'border-primary/40',
      )}
      data-proposal={proposal ? 'true' : undefined}
    >
      {resolved ? (
        <div className='flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground'>
          <Button
            variant='ghost'
            size='icon-xs'
            aria-expanded
            aria-label={t('np.threads.collapse')}
            onClick={() => setExpanded(false)}
          >
            <ChevronDownIcon />
          </Button>
          <CheckCircle2Icon className='size-3.5' aria-hidden='true' />
          <span>
            {thread.root.resolvedByName
              ? t('np.threads.resolvedBy', {
                  name: thread.root.resolvedByName,
                })
              : t('np.threads.resolved')}
          </span>
          <Button
            variant='ghost'
            size='xs'
            className='ml-auto'
            disabled={resolve.isPending}
            onClick={() => resolve.mutate(false)}
          >
            <RotateCcwIcon data-icon='inline-start' />
            {t('np.threads.unresolve')}
          </Button>
        </div>
      ) : null}
      <CommentBlock
        comment={thread.root}
        context={context}
        onResolve={
          resolved || thread.root.kind === 'system'
            ? undefined
            : () => resolve.mutate(true)
        }
        resolving={resolve.isPending}
      />
      {thread.replies.length > 0 ? (
        <div className='space-y-0 border-t bg-muted/30'>
          {thread.replies.map((reply) => (
            <CommentBlock
              key={reply.id}
              comment={reply}
              context={context}
              nested
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function CommentBlock({
  comment,
  context,
  onResolve,
  resolving = false,
  nested = false,
}: {
  readonly comment: IssueComment;
  readonly context: ThreadContext;
  readonly onResolve?: () => void;
  readonly resolving?: boolean;
  readonly nested?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const name = authorLabel(comment, context.agentName, t('np.common.unknown'));
  const tag = context.commentTag?.(comment) ?? null;
  return (
    <div
      data-comment-id={comment.id}
      data-comment-kind={tag ?? undefined}
      className={cn(
        'group space-y-1.5 p-3',
        nested && 'pl-9',
        context.replyingToId === comment.id && 'bg-accent/50',
      )}
    >
      <header className='flex items-center gap-2 text-sm'>
        <NpActorAvatar type={comment.authorType} name={name} />
        <span className='truncate font-medium'>{name}</span>
        {comment.authorType === 'agent' ? (
          <NpTag tone='violet'>{t('np.executor.agentMarker')}</NpTag>
        ) : null}
        <NpCommentTag tag={tag} />
        <time
          dateTime={comment.createdAt}
          title={format.dateTime(comment.createdAt)}
          className='text-xs text-muted-foreground'
        >
          {format.relative(comment.createdAt)}
        </time>
        <div className='ml-auto flex items-center gap-1'>
          {onResolve ? (
            <Button
              variant='ghost'
              size='xs'
              className='text-muted-foreground'
              disabled={resolving}
              onClick={onResolve}
            >
              <CheckCircle2Icon data-icon='inline-start' />
              {t('np.threads.resolve')}
            </Button>
          ) : null}
          <Button
            variant='ghost'
            size='xs'
            className='text-muted-foreground'
            aria-label={t('np.comment.replyTo', { name })}
            onClick={() => context.onReply(comment)}
          >
            <ReplyIcon data-icon='inline-start' />
            {t('np.comment.reply')}
          </Button>
        </div>
      </header>
      <NpMarkdown content={comment.content} className='pl-8' />
      <div className='pl-8'>
        <CommentReactions
          issueId={context.issueId}
          comment={comment}
          meUserId={context.meUserId}
          userName={context.userName}
        />
      </div>
    </div>
  );
}

function SystemComment({
  comment,
}: {
  readonly comment: IssueComment;
}): ReactElement {
  const format = useNpFormatters();
  return (
    <div className='flex items-start gap-2 px-1 text-sm text-muted-foreground'>
      <CircleDotIcon className='mt-0.5 size-3.5 shrink-0' aria-hidden='true' />
      <NpMarkdown content={comment.content} className='flex-1' />
      <time dateTime={comment.createdAt} className='shrink-0 text-xs'>
        {format.relative(comment.createdAt)}
      </time>
    </div>
  );
}
