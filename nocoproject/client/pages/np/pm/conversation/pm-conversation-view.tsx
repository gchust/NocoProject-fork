import { ApiClientError } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { BotMessageSquareIcon, ClockIcon } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';

import { NpDetailSkeleton, NpEmpty, NpLoadError } from '@/components/np-states';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import {
  activeSessionRun,
  sessionHint,
} from '../../issues/detail/session-model.js';
import type { IssueDetail } from '../../types.js';
import type { PmConversationDetail } from '../../types-pm.js';
import { PmAgentNotice } from './pm-agent-status.js';
import { PmComposer } from './pm-composer.js';
import { pmMessages } from './pm-conversation-model.js';
import { PmLiveTurn, PmTurnAnnouncer } from './pm-live-turn.js';
import { PmMessageItem } from './pm-message.js';
import {
  usePmConversationActions,
  usePmConversationDetail,
  usePmConversationIssue,
} from './use-pm-conversation.js';

/**
 * One project manager conversation — the drawer's body and the full-width `/pm/:conversationId` page (NP-185): the
 * messages as a log, the turn in progress, notices about who answers, and the composer. With no conversation
 * (`conversationId = null`) it is a new one: an empty log and a composer whose first message creates it.
 */
export function PmConversationView({
  conversationId,
  onConversation,
  onStartNew,
  className,
}: {
  readonly conversationId: string | null;
  /** A new conversation was created by its first message. */
  readonly onConversation: (conversationId: string) => void;
  readonly onStartNew: () => void;
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  const detail = usePmConversationDetail(conversationId);
  const issue = usePmConversationIssue(detail.data?.issueId, conversationId);

  if (conversationId && detail.isError && !detail.data) {
    const gone =
      detail.error instanceof ApiClientError &&
      [403, 404].includes(detail.error.status);
    return gone ? (
      <NpEmpty
        icon={<BotMessageSquareIcon />}
        title={t('np.pmAssistant.notFound')}
        description={t('np.pmAssistant.notFoundDescription')}
        action={
          <Button variant='outline' onClick={onStartNew}>
            {t('np.pmAssistant.newConversation')}
          </Button>
        }
      />
    ) : (
      <NpLoadError
        title={t('np.pm.loadFailed')}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  if (conversationId && (!detail.data || (!issue.data && !issue.isError))) {
    return <NpDetailSkeleton />;
  }
  if (issue.isError && !issue.data) {
    return (
      <NpLoadError
        title={t('np.pm.loadFailed')}
        error={issue.error}
        onRetry={() => void issue.refetch()}
      />
    );
  }
  return (
    <PmConversationBody
      key={conversationId ?? 'new'}
      conversation={detail.data ?? null}
      issue={issue.data ?? null}
      onConversation={onConversation}
      className={className}
    />
  );
}

function PmConversationBody({
  conversation,
  issue,
  onConversation,
  className,
}: {
  readonly conversation: PmConversationDetail | null;
  readonly issue: IssueDetail | null;
  readonly onConversation: (conversationId: string) => void;
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  const actions = usePmConversationActions();
  const [notConfigured, setNotConfigured] = useState(false);
  const messages = issue ? pmMessages(issue.threads) : [];
  const run = issue ? activeSessionRun(issue.runs) : null;
  const hint = issue ? sessionHint(run, issue.queuedRun) : null;
  const agentName =
    conversation?.agent.name ?? t('np.pmAssistant.defaultName');

  const listRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  const runId = run?.id;
  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count, runId]);

  return (
    <section
      className={cn('flex h-full min-h-0 flex-col gap-3', className)}
      aria-label={conversation?.title ?? t('np.pmAssistant.newConversation')}
      data-testid='np-pm-conversation'
    >
      <div ref={listRef} className='min-h-0 flex-1 overflow-y-auto'>
        {count === 0 && !run ? (
          <div className='flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center'>
            <BotMessageSquareIcon
              className='size-8 text-muted-foreground'
              aria-hidden='true'
            />
            <p className='text-sm font-medium'>
              {t('np.pmAssistant.emptyTitle')}
            </p>
            <p className='text-sm text-muted-foreground'>
              {t('np.pmAssistant.emptyDescription')}
            </p>
          </div>
        ) : (
          <ol
            role='log'
            aria-label={t('np.pmAssistant.messages')}
            className='flex flex-col gap-4 py-1'
          >
            {messages.map((message) => (
              <PmMessageItem
                key={message.comment.id}
                message={message}
                issueId={issue?.issue.id ?? ''}
                agentName={agentName}
              />
            ))}
            {run && issue ? (
              <li>
                <PmLiveTurn
                  key={run.id}
                  run={run}
                  issueId={issue.issue.id}
                  agentName={run.agentName ?? agentName}
                />
              </li>
            ) : null}
          </ol>
        )}
      </div>
      <PmTurnAnnouncer running={Boolean(run)} />
      <PmComposer
        conversation={conversation}
        activeRun={run}
        onCreated={(created) => onConversation(created.id)}
        onSent={(sent) => setNotConfigured(sent.notConfigured)}
        notice={
          <>
            <PmAgentNotice
              agent={conversation?.agent ?? null}
              notConfigured={notConfigured}
              busy={actions.switchAgent.isPending}
              onFallback={() =>
                conversation &&
                actions.switchAgent.mutate({ id: conversation.id, to: 'fallback' })
              }
              onRestore={() =>
                conversation &&
                actions.switchAgent.mutate({ id: conversation.id, to: 'restore' })
              }
            />
            {hint ? (
              <p
                className='flex items-center gap-1.5 text-xs text-muted-foreground'
                data-testid='np-session-hint'
              >
                <ClockIcon className='size-3.5' aria-hidden='true' />
                {hint.kind === 'queued'
                  ? t('np.session.queued', { count: hint.count })
                  : t('np.session.working')}
              </p>
            ) : null}
          </>
        }
      />
    </section>
  );
}
