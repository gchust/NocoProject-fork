import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon, ScrollTextIcon, SquareIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';

import { NpRunStatusBadge } from '@/components/np-badges';
import { RuntimeTypeName, RuntimeTypeTag } from '@/components/np-runtime-type';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

import { cancelRun, retryRun } from '../../api.js';
import {
  CANCELLABLE_RUN_STATUSES,
  npKeys,
  RETRYABLE_RUN_STATUSES,
} from '../../constants.js';
import { runTriggerType } from '../../detail-normalize.js';
import {
  durationText,
  failureReasonKey,
  useNpFormatters,
} from '../../format.js';
import type { AgentListItem, RunSummary } from '../../types.js';
import {
  RUNTIME_TYPES,
  runtimeTypeOf,
  type RuntimeType,
} from '../../types-runtime-types.js';

/** Runs on this issue, newest first, with transcript, stop and retry. */
export function ExecutionLog({
  runs,
  agents,
  issueId,
}: {
  readonly runs: readonly RunSummary[];
  readonly agents: readonly AgentListItem[];
  readonly issueId: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [stopping, setStopping] = useState<{
    readonly open: boolean;
    readonly run: RunSummary | null;
  }>({ open: false, run: null });

  const [typeFilter, setTypeFilter] = useState<RuntimeType | 'all'>('all');
  // The filter is offered only when this issue has runs of both types (NP-219 §9.2).
  const typesPresent = RUNTIME_TYPES.filter((type) =>
    runs.some((run) => runtimeTypeOf(run) === type),
  );
  const filtered =
    typeFilter === 'all' || !typesPresent.includes(typeFilter)
      ? runs
      : runs.filter((run) => runtimeTypeOf(run) === typeFilter);

  const agentName = (run: RunSummary): string =>
    run.agentName ??
    agents.find((agent) => agent.id === run.agentId)?.name ??
    t('np.common.unknownAgent');

  async function act(
    run: RunSummary,
    action: 'cancel' | 'retry',
  ): Promise<void> {
    setPendingId(run.id);
    try {
      if (action === 'cancel') {
        await cancelRun(api, run.id);
        toast.add({ type: 'success', title: t('np.runs.stopRequested') });
      } else {
        await retryRun(api, run.id);
        toast.add({ type: 'success', title: t('np.runs.retried') });
      }
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    } catch (error: unknown) {
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError && error.status === 409
              ? t('np.runs.stateChanged')
              : t('np.common.requestFailed'),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className='space-y-3' aria-labelledby='np-runs-heading'>
      <div className='flex items-center justify-between gap-2'>
        <h2 id='np-runs-heading' className='text-sm font-semibold'>
          {t('np.runs.title')}
        </h2>
        {typesPresent.length > 1 ? (
          <Select
            value={typeFilter}
            onValueChange={(next) => {
              if (next) setTypeFilter(next);
            }}
          >
            <SelectTrigger
              size='sm'
              aria-label={t('np.runtimeType.runs.filter')}
              data-testid='np-runs-type-filter'
            >
              <SelectValue>
                {(value: string) =>
                  value === 'all' ? (
                    t('np.runtimeType.all')
                  ) : (
                    <RuntimeTypeName type={value as RuntimeType} />
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>{t('np.runtimeType.all')}</SelectItem>
              {RUNTIME_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  <RuntimeTypeName type={type} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {runs.length === 0 ? (
        <p className='text-sm text-muted-foreground'>{t('np.runs.empty')}</p>
      ) : (
        <ul className='space-y-2'>
          {filtered.map((run) => (
            <RunItem
              key={run.id}
              run={run}
              agentName={agentName(run)}
              pending={pendingId === run.id}
              onStop={() => setStopping({ open: true, run })}
              onRetry={() => void act(run, 'retry')}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={stopping.open}
        onOpenChange={(open) => {
          if (!open) setStopping((current) => ({ ...current, open: false }));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('np.runs.stopTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.runs.stopDescription', {
                name: stopping.run ? agentName(stopping.run) : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                const target = stopping.run;
                setStopping((current) => ({ ...current, open: false }));
                if (target) void act(target, 'cancel');
              }}
            >
              {t('np.runs.stop')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RunItem({
  run,
  agentName,
  pending,
  onStop,
  onRetry,
}: {
  readonly run: RunSummary;
  readonly agentName: string;
  readonly pending: boolean;
  readonly onStop: () => void;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const trigger = runTriggerType(run);
  const duration = durationText(run.startedAt, run.finishedAt);
  const cancelRequested = Boolean(run.cancelRequestedAt);

  return (
    <li className='space-y-2 rounded-lg border bg-card p-3 text-card-foreground'>
      <div className='flex items-center gap-2'>
        <NpRunStatusBadge status={run.status} />
        <span className='min-w-0 truncate text-sm font-medium'>
          {agentName}
        </span>
        <RuntimeTypeTag type={runtimeTypeOf(run)} iconOnly />
        <time
          dateTime={run.createdAt}
          title={format.dateTime(run.createdAt)}
          className='ml-auto shrink-0 text-xs text-muted-foreground'
        >
          {format.relative(run.createdAt)}
        </time>
      </div>
      <dl className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
        {trigger ? (
          <>
            <dt>{t('np.runs.trigger')}</dt>
            <dd>{t(`np.trigger.${trigger}`, { defaultValue: trigger })}</dd>
          </>
        ) : null}
        <dt>{t('np.runs.started')}</dt>
        <dd>{format.dateTime(run.startedAt)}</dd>
        <dt>{t('np.runs.finished')}</dt>
        <dd>
          {format.dateTime(run.finishedAt)}
          {duration ? ` · ${duration}` : ''}
        </dd>
        {run.attempt && run.attempt > 1 ? (
          <>
            <dt>{t('np.runs.attempt')}</dt>
            <dd>{run.attempt}</dd>
          </>
        ) : null}
        {run.branchName ? (
          <>
            <dt>{t('np.runs.branch')}</dt>
            <dd
              className='wrap-anywhere font-mono'
              title={run.repoUrl ?? undefined}
            >
              {run.branchName}
            </dd>
          </>
        ) : null}
        {run.failureReason ? (
          <>
            <dt>{t('np.runs.failure')}</dt>
            <dd className='wrap-anywhere text-destructive'>
              {t(failureReasonKey(run.failureReason), {
                defaultValue: run.failureReason,
              })}
            </dd>
          </>
        ) : null}
      </dl>
      <div className='flex flex-wrap gap-1.5'>
        <Button
          variant='outline'
          size='xs'
          nativeButton={false}
          render={<Link to={`runs/${encodeURIComponent(run.id)}`} />}
        >
          <ScrollTextIcon data-icon='inline-start' />
          {t('np.runs.viewTranscript')}
        </Button>
        {CANCELLABLE_RUN_STATUSES.has(run.status) ? (
          <Button
            variant='outline'
            size='xs'
            disabled={pending || cancelRequested}
            onClick={onStop}
          >
            {pending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <SquareIcon data-icon='inline-start' />
            )}
            {cancelRequested ? t('np.runs.stopping') : t('np.runs.stop')}
          </Button>
        ) : null}
        {RETRYABLE_RUN_STATUSES.has(run.status) ? (
          <Button
            variant='outline'
            size='xs'
            disabled={pending}
            onClick={onRetry}
          >
            {pending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <RotateCcwIcon data-icon='inline-start' />
            )}
            {t('np.runs.retry')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
