import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, BotIcon } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';
import { useParams } from 'react-router';

import { NpRunStatusBadge } from '@/components/np-badges';
import { RouteDialog } from '@/components/route-dialog';
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { fetchAgents, fetchRun } from '../../api.js';
import { ACTIVE_RUN_STATUSES, npKeys } from '../../constants.js';
import { runTriggerType } from '../../detail-normalize.js';
import {
  durationText,
  failureReasonKey,
  useNpFormatters,
} from '../../format.js';
import type { RunTopicPayload } from '../../types.js';
import { useRealtimeTopic } from '../../use-realtime.js';
import { TranscriptEvent } from './transcript-event.js';
import { useRunEvents } from './use-run-events.js';
import { usePmContextSource } from '../../pm/assistant/pm-assistant.js';

/**
 * Route `/issues/:issueId/runs/:runId`: a run's transcript.
 *
 * Events arrive by incremental fetches (`since=<last seq>`), triggered by `np:run:<id>` realtime signals and, while
 * the run is still active, by a three-second poll in case a signal is lost.
 */
export default function RunTranscriptPage(): ReactElement {
  const { t } = useTranslation();
  const { runId = '' } = useParams();
  return (
    <RouteDialog title={t('np.transcript.title')} className='sm:max-w-4xl'>
      <TranscriptBody key={runId} runId={runId} />
    </RouteDialog>
  );
}

function TranscriptBody({ runId }: { readonly runId: string }): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();

  const run = useQuery({
    queryKey: npKeys.run(runId),
    queryFn: () => fetchRun(api, runId),
    refetchInterval: (query) =>
      query.state.data && ACTIVE_RUN_STATUSES.has(query.state.data.status)
        ? 3000
        : false,
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  usePmContextSource(
    run.data
      ? {
          type: 'run',
          id: runId,
          label: t('np.pmAssistant.context.run', {
            agent: run.data.agentName ?? run.data.agentId,
          }),
        }
      : null,
  );

  const active = run.data ? ACTIVE_RUN_STATUSES.has(run.data.status) : true;
  const events = useRunEvents(runId, active);

  useRealtimeTopic<RunTopicPayload>(`np:run:${runId}`, (payload) => {
    events.fetchMore();
    if (!payload || payload.kind === 'run.status') {
      void queryClient.invalidateQueries({ queryKey: npKeys.run(runId) });
    }
  });

  // Follow the newest event while the reader is at the bottom; leave the scroll alone once they scroll up.
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const count = events.events.length;
  useEffect(() => {
    const element = listRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [count]);

  const data = run.data;
  const agentName =
    data?.agentName ??
    agents.data?.find((agent) => agent.id === data?.agentId)?.name ??
    null;
  const trigger = data ? runTriggerType(data) : null;
  const duration = data ? durationText(data.startedAt, data.finishedAt) : null;

  if (run.isError && !data) {
    const status =
      run.error instanceof ApiClientError ? run.error.status : undefined;
    return (
      <Alert variant='destructive'>
        <AlertCircleIcon />
        <AlertDescription>
          {status === 404
            ? t('np.transcript.notFound')
            : status === 403
              ? t('np.common.forbidden')
              : t('np.common.requestFailed')}
        </AlertDescription>
        {status === 404 || status === 403 ? null : (
          <AlertAction>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void run.refetch()}
            >
              {t('status.retry')}
            </Button>
          </AlertAction>
        )}
      </Alert>
    );
  }

  return (
    <div className='flex min-h-0 flex-col gap-3'>
      {data?.configurationSnapshot ? (
        <details>
          <summary>{t('np.capabilities.preview')}</summary>
          <pre className='whitespace-pre-wrap'>
            {JSON.stringify(data.configurationSnapshot, null, 2)}
          </pre>
        </details>
      ) : null}
      {data ? (
        <div className='space-y-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <NpRunStatusBadge status={data.status} />
            <span className='inline-flex items-center gap-1.5 font-medium'>
              <BotIcon
                className='size-4 text-muted-foreground'
                aria-hidden='true'
              />
              {agentName ?? t('np.common.unknownAgent')}
            </span>
            {trigger ? (
              <span className='text-sm text-muted-foreground'>
                · {t(`np.trigger.${trigger}`, { defaultValue: trigger })}
              </span>
            ) : null}
          </div>
          <p className='text-xs text-muted-foreground'>
            {t('np.transcript.summary', {
              created: format.dateTime(data.createdAt),
              count,
            })}
            {duration ? ` · ${t('np.transcript.took', { duration })}` : ''}
          </p>
          {data.failureReason ? (
            <p className='text-sm text-destructive'>
              {t(failureReasonKey(data.failureReason), {
                defaultValue: data.failureReason,
              })}
              {data.failureDetail ? ` — ${data.failureDetail}` : ''}
            </p>
          ) : null}
        </div>
      ) : (
        <Skeleton className='h-10 w-2/3' />
      )}

      <div
        ref={listRef}
        className='max-h-[60svh] min-h-40 overflow-y-auto rounded-lg border'
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
        }}
      >
        {!events.loaded ? (
          <div
            role='status'
            aria-label={t('status.loading')}
            className='space-y-2 p-4'
          >
            <Skeleton className='h-5 w-full' />
            <Skeleton className='h-5 w-5/6' />
            <Skeleton className='h-5 w-2/3' />
          </div>
        ) : count === 0 ? (
          <p className='p-6 text-center text-sm text-muted-foreground'>
            {active ? t('np.transcript.waiting') : t('np.transcript.empty')}
          </p>
        ) : (
          <ol aria-label={t('np.transcript.title')}>
            {events.events.map((event) => (
              <TranscriptEvent key={event.seq} event={event} />
            ))}
          </ol>
        )}
      </div>
      {events.error && events.loaded ? (
        <p className='text-xs text-destructive'>
          {t('np.transcript.fetchFailed')}
        </p>
      ) : null}
    </div>
  );
}
