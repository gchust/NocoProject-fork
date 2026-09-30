import { useTranslation } from '@nocobase/i18n/client';
import { ListChecksIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpMarkdown } from '@/components/np-markdown';
import { cn } from '@/lib/utils';

import { useNpFormatters } from '../../format.js';
import { PmPlanCard } from '../plan/pm-plan-card.js';
import { PmSentContext } from '../context/pm-context-chips.js';
import type { PmMessage } from './pm-conversation-model.js';
import { PmReferenceCards } from './pm-reference-cards.js';

/**
 * One entry of a project manager conversation (NP-185): the member's message on the right with the context it
 * carried, the project manager's reply on the left with cards for what it mentions, a plan card, a plan's results,
 * or a centred system line ("switched to the default project manager").
 */
export function PmMessageItem({
  message,
  issueId,
  conversationId,
  agentName,
}: {
  readonly message: PmMessage;
  readonly issueId: string;
  readonly conversationId: string;
  readonly agentName: string;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const { comment } = message;
  const time = (
    <time
      dateTime={comment.createdAt}
      className='text-xs text-muted-foreground'
      title={format.dateTime(comment.createdAt)}
    >
      {format.relative(comment.createdAt)}
    </time>
  );

  if (message.kind === 'system') {
    return (
      <li className='flex justify-center px-4' data-pm-message='system'>
        <p className='max-w-full text-center text-xs text-muted-foreground wrap-anywhere'>
          {comment.content} · {time}
        </p>
      </li>
    );
  }
  if (message.kind === 'plan') {
    return (
      <li data-pm-message='plan'>
        <PmPlanCard
          commentId={comment.id}
          conversationId={conversationId}
          issueId={issueId}
        />
      </li>
    );
  }
  if (message.kind === 'planResult') {
    return (
      <li data-pm-message='plan-result'>
        <section
          className='rounded-lg border border-dashed px-3 py-2 text-sm'
          aria-label={t('np.pmAssistant.plan.resultTitle')}
        >
          <p className='mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground'>
            <ListChecksIcon className='size-3.5' aria-hidden='true' />
            {t('np.pmAssistant.plan.resultTitle')}
            <span className='ml-auto font-normal'>{time}</span>
          </p>
          <NpMarkdown content={comment.content} />
        </section>
      </li>
    );
  }

  const fromAgent = message.kind === 'agent';
  const name = fromAgent
    ? (comment.authorName ?? agentName)
    : (comment.authorName ?? t('np.common.unknown'));
  return (
    <li
      className={cn('flex gap-2', !fromAgent && 'flex-row-reverse')}
      data-pm-message={message.kind}
    >
      <NpActorAvatar
        type={fromAgent ? 'agent' : 'user'}
        name={name}
        size='sm'
        className='mt-0.5'
      />
      <div
        className={cn(
          'flex min-w-0 flex-col',
          fromAgent ? 'max-w-[92%] items-start' : 'max-w-[85%] items-end',
        )}
      >
        <p className='mb-1 flex items-center gap-2 text-xs'>
          <span className='font-medium text-muted-foreground'>{name}</span>
          {time}
        </p>
        <div
          className={cn(
            'max-w-full min-w-0 rounded-lg px-3 py-2 text-sm',
            fromAgent ? 'bg-muted' : 'bg-primary/10',
          )}
        >
          <NpMarkdown content={comment.content} />
        </div>
        {!fromAgent && comment.context ? (
          <PmSentContext context={comment.context} />
        ) : null}
        {fromAgent ? <PmReferenceCards content={comment.content} /> : null}
      </div>
    </li>
  );
}
