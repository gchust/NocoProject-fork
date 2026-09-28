import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { BotIcon, ClockIcon, MessagesSquareIcon, UserIcon } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';

import { NpPulse } from '@/components/np-badges';
import { NpMarkdown } from '@/components/np-markdown';
import type { NpRichTextHandle } from '@/components/np-rich-text-editor';
import { cn } from '@/lib/utils';

import { npKeys } from '../../constants.js';
import { useNpFormatters } from '../../format.js';
import type {
  AgentListItem,
  IssueDetail,
  RunSummary,
  RunTopicPayload,
} from '../../types.js';
import { useRealtimeTopic } from '../../use-realtime.js';
import { CommentComposer } from './comment-composer.js';
import {
  activeSessionRun,
  sessionHint,
  sessionMessages,
} from './session-model.js';
import { TranscriptEvent } from './transcript-event.js';
import { useRunEvents } from './use-run-events.js';

/**
 * The execution panel in session mode (iteration 2 §J): the conversation with the agent — top-level comments as
 * messages, the working turn streamed live from `np:run:<id>` — and a message box that posts a top-level comment
 * (with `@` and `/note`). While the agent works, the box says the message will be sent after this turn.
 */
export function SessionPanel({
  detail,
  agents,
  fill = false,
  placeholder,
}: {
  readonly detail: IssueDetail;
  readonly agents: readonly AgentListItem[];
  /**
   * Fill the parent's height as the page's own conversation (the project manager, iteration 4 §C): no heading, the
   * message list takes the free height and scrolls, the composer stays under it. The parent bounds the height.
   */
  readonly fill?: boolean;
  readonly placeholder?: string;
}): ReactElement {
  const { t } = useTranslation();
  const { issue } = detail;
  const editorRef = useRef<NpRichTextHandle>(null);
  const messages = sessionMessages(detail.threads);
  const run = activeSessionRun(detail.runs);
  const hint = sessionHint(run, detail.queuedRun);
  const agentName = (agentId: string | null | undefined): string | null =>
    agents.find((agent) => agent.id === agentId)?.name ?? null;

  const listRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  const runId = run?.id;
  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count, runId]);

  return (
    <section
      className={cn(fill ? 'flex h-full min-h-0 flex-col gap-3' : 'space-y-3')}
      aria-labelledby='np-session-heading'
      data-testid='np-session-panel'
    >
      <h2
        id='np-session-heading'
        className={cn(
          'flex items-center gap-2 text-sm font-semibold',
          fill && 'sr-only',
        )}
      >
        <MessagesSquareIcon className='size-4' aria-hidden='true' />
        {t('np.session.title')}
      </h2>
      <div
        ref={listRef}
        className={cn(
          'space-y-3 overflow-y-auto rounded-lg border',
          fill
            ? 'min-h-0 flex-1 bg-card p-4'
            : 'max-h-[50svh] min-h-32 bg-background p-3',
        )}
      >
        {messages.length === 0 && !run ? (
          <p className='text-sm text-muted-foreground'>
            {t('np.session.empty')}
          </p>
        ) : null}
        {messages.map((message) => {
          const fromAgent = message.authorType === 'agent';
          const Icon = fromAgent ? BotIcon : UserIcon;
          const name =
            message.authorName ??
            (fromAgent ? agentName(message.authorId) : null) ??
            t('np.common.unknown');
          return (
            <div
              key={message.id}
              className={cn('flex gap-2', !fromAgent && 'flex-row-reverse')}
            >
              <span
                className='flex size-6 shrink-0 items-center justify-center rounded-full bg-muted'
                aria-hidden='true'
              >
                <Icon className='size-3.5 text-muted-foreground' />
              </span>
              <div
                className={cn(
                  'max-w-[85%] min-w-0 rounded-lg px-3 py-2',
                  fromAgent ? 'bg-muted' : 'bg-primary/10',
                )}
              >
                <p className='mb-1 text-xs font-medium text-muted-foreground'>
                  {name}
                </p>
                <NpMarkdown content={message.content} />
              </div>
            </div>
          );
        })}
        {run ? <LiveTurn key={run.id} run={run} agentName={agentName} /> : null}
      </div>
      <CommentComposer
        issueId={issue.id}
        executor={{ type: issue.executorType, id: issue.executorId }}
        agents={agents}
        agentName={agentName}
        replyTo={null}
        replyToName={null}
        onCancelReply={() => {}}
        editorRef={editorRef}
        placeholder={placeholder ?? t('np.session.placeholder')}
        notice={
          hint ? (
            <p
              className='flex items-center gap-1.5 text-xs text-muted-foreground'
              aria-live='polite'
              data-testid='np-session-hint'
            >
              <ClockIcon className='size-3.5' aria-hidden='true' />
              {hint.kind === 'queued'
                ? t('np.session.queued', { count: hint.count })
                : t('np.session.working')}
            </p>
          ) : null
        }
      />
    </section>
  );
}

/** The turn in progress: the run's events as they stream in, refetched on each `np:run:<id>` signal. */
function LiveTurn({
  run,
  agentName,
}: {
  readonly run: RunSummary;
  readonly agentName: (agentId: string | null | undefined) => string | null;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const format = useNpFormatters();
  const events = useRunEvents(run.id, true);
  const [expanded, setExpanded] = useState(false);
  useRealtimeTopic<RunTopicPayload>(`np:run:${run.id}`, (payload) => {
    events.fetchMore();
    if (!payload || payload.kind === 'run.status') {
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void queryClient.invalidateQueries({ queryKey: ['np', 'issue'] });
    }
  });
  const shown = expanded ? events.events : events.events.slice(-8);
  const name =
    run.agentName ?? agentName(run.agentId) ?? t('np.common.unknownAgent');

  return (
    <div
      className='space-y-2 rounded-lg border border-dashed p-2'
      aria-live='polite'
    >
      <p className='flex items-center gap-2 text-xs text-muted-foreground'>
        <NpPulse />
        {t('np.session.agentWorking', { name })}
        <span className='ml-auto'>
          {format.relative(run.startedAt ?? run.createdAt)}
        </span>
      </p>
      {events.events.length > shown.length ? (
        <button
          type='button'
          className='text-xs text-muted-foreground underline-offset-4 hover:underline'
          onClick={() => setExpanded(true)}
        >
          {t('np.session.earlier', {
            count: events.events.length - shown.length,
          })}
        </button>
      ) : null}
      <ol aria-label={t('np.transcript.title')}>
        {shown.map((event) => (
          <TranscriptEvent key={event.seq} event={event} />
        ))}
      </ol>
    </div>
  );
}
