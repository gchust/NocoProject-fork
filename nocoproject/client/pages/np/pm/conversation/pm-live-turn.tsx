import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';

import { NpPulse } from '@/components/np-badges';
import { NpMarkdown } from '@/components/np-markdown';
import { cn } from '@/lib/utils';

import { npKeys } from '../../constants.js';
import { TranscriptEvent } from '../../issues/detail/transcript-event.js';
import { useRunEvents } from '../../issues/detail/use-run-events.js';
import type { RunSummary, RunTopicPayload } from '../../types.js';
import { useRealtimeTopic } from '../../use-realtime.js';
import { liveTurnView } from './pm-conversation-model.js';

/**
 * The project manager's turn in progress (NP-185): its thinking and tool calls fold into one line — "Looking at
 * NP-12…" — that expands to the steps, and the reply streams under it. Screen readers hear "replying" once when the
 * turn starts and "reply finished" once when it ends, not every token.
 */
export function PmLiveTurn({
  run,
  issueId,
  agentName,
}: {
  readonly run: RunSummary;
  readonly issueId: string;
  readonly agentName: string;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const events = useRunEvents(run.id, true);
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();
  useRealtimeTopic<RunTopicPayload>(`np:run:${run.id}`, (payload) => {
    events.fetchMore();
    if (!payload || payload.kind === 'run.status') {
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
    }
  });
  const view = liveTurnView(events.events);
  const line = view.current
    ? t('np.pmAssistant.turn.working', { step: view.current })
    : t('np.pmAssistant.turn.thinking');

  return (
    <div
      className='flex flex-col gap-2'
      data-testid='np-pm-live-turn'
      aria-busy='true'
    >
      <p className='flex min-w-0 items-center gap-1 text-xs text-muted-foreground'>
        <NpPulse className='mr-1' />
        <span className='shrink-0 font-medium'>{agentName}</span>
      </p>
      {view.steps.length > 0 ? (
        <div>
          <button
            type='button'
            className='flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-muted-foreground hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none'
            aria-expanded={expanded}
            aria-controls={stepsId}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRightIcon
              className={cn(
                'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
                expanded && 'rotate-90',
              )}
              aria-hidden='true'
            />
            <span className='truncate'>{line}</span>
            <span className='ml-auto shrink-0 tabular-nums'>
              {t('np.pmAssistant.turn.steps', { count: view.steps.length })}
            </span>
          </button>
          {expanded ? (
            <ol
              id={stepsId}
              aria-label={t('np.transcript.title')}
              className='mt-1 max-h-80 overflow-y-auto rounded-md border p-2'
            >
              {view.steps.map((event) => (
                <TranscriptEvent key={event.seq} event={event} />
              ))}
            </ol>
          ) : null}
        </div>
      ) : (
        <p className='px-1.5 text-xs text-muted-foreground'>{line}</p>
      )}
      {view.reply ? (
        <div className='max-w-full rounded-lg bg-muted px-3 py-2 text-sm'>
          <NpMarkdown content={view.reply} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Announces the start and the end of a turn once each (a polite live region that stays mounted), so the streamed
 * text itself is not read out token by token.
 */
export function PmTurnAnnouncer({
  running,
}: {
  readonly running: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) {
    setWasRunning(running);
    setMessage(
      running
        ? t('np.pmAssistant.turn.started')
        : t('np.pmAssistant.turn.finished'),
    );
  }
  return (
    <p className='sr-only' aria-live='polite' data-testid='np-pm-announcer'>
      {message}
    </p>
  );
}
