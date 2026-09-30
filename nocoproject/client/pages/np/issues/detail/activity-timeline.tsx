import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { CircleDotIcon, PlayIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpPulse, NpStatusBadge } from '@/components/np-badges';
import { NpTag } from '@/components/np-tag';
import { NpVirtualList } from '@/components/np-virtual-list';

import { fetchMe } from '../../api.js';
import { npKeys } from '../../constants.js';
import { runTriggerType } from '../../detail-normalize.js';
import { failureReasonKey, useNpFormatters } from '../../format.js';
import type {
  IssueActivity,
  RunSummary,
  StatusCatalogEntry,
} from '../../types.js';
import { NpProcessBadge } from '../process-fields.js';
import { ThreadCard, type ThreadContext } from './comment-thread.js';
import {
  STATUS_CHANGE_LABELS,
  activityChange,
  activityLabel,
  type TimelineEntry,
} from './timeline.js';

export interface ActivityTimelineProps extends ThreadContext {
  readonly entries: readonly TimelineEntry[];
  readonly statusCatalog: readonly StatusCatalogEntry[];
}

/**
 * Comments as threads, system activity as compact rows, and agent runs inline, oldest first. Past 100 entries the
 * list is virtualized against the detail's scrolling column (§H 8).
 */
export function ActivityTimeline({
  entries,
  statusCatalog,
  ...context
}: ActivityTimelineProps): ReactElement {
  const { agentName } = context;
  const { t } = useTranslation();
  if (entries.length === 0) {
    return (
      <p className='text-sm text-muted-foreground'>{t('np.activity.empty')}</p>
    );
  }
  return (
    <NpVirtualList
      items={entries}
      itemKey={(entry) => entry.key}
      label={t('np.activity.title')}
      renderItem={(entry) =>
        entry.kind === 'thread' ? (
          <ThreadCard thread={entry.thread} context={context} />
        ) : entry.kind === 'activity' ? (
          <ActivityRow
            activity={entry.activity}
            statusCatalog={statusCatalog}
            agentName={agentName}
          />
        ) : (
          <RunRow run={entry.run} agentName={agentName} />
        )
      }
    />
  );
}

type ActivityVia = 'cli' | 'api_key' | 'pm' | 'pm_plan';
const VIAS: ReadonlySet<string> = new Set<ActivityVia>([
  'cli',
  'api_key',
  'pm',
  'pm_plan',
]);

/**
 * `details.via` (NP-86): set when the actor used an API key — the CLI user mode or another client — not the browser;
 * `pm` / `pm_plan` (NP-185, `protocol-pm-assistant.md` §2.4) when the project manager wrote as the person, or the
 * person executed its plan.
 */
export function activityVia(details: IssueActivity['details']): ActivityVia | null {
  const via = details?.via;
  return typeof via === 'string' && VIAS.has(via) ? (via as ActivityVia) : null;
}

/**
 * "Via the project manager" links to the conversation only for the person the activity is recorded under — the
 * conversation's owner; everyone else reads the words alone, since conversations are private.
 */
function ViaMarker({
  via,
  activity,
}: {
  readonly via: ActivityVia;
  readonly activity: IssueActivity;
}): ReactElement {
  const { t } = useTranslation();
  const conversationId = activity.details?.conversationId;
  if ((via === 'pm' || via === 'pm_plan') && typeof conversationId === 'string') {
    return (
      <PmViaMarker
        via={via}
        conversationId={conversationId}
        actorId={activity.actorType === 'user' ? activity.actorId : null}
      />
    );
  }
  return (
    <span className='text-xs' data-np-via={via}>
      {t(`np.activity.via.${via}`)}
    </span>
  );
}

function PmViaMarker({
  via,
  conversationId,
  actorId,
}: {
  readonly via: 'pm' | 'pm_plan';
  readonly conversationId: string;
  readonly actorId: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  const text = t(`np.activity.via.${via}`);
  return actorId !== null && me.data?.userId === actorId ? (
    <Link
      to={`/pm/${encodeURIComponent(conversationId)}`}
      className='text-xs hover:text-foreground hover:underline'
      data-np-via={via}
    >
      {text}
    </Link>
  ) : (
    <span className='text-xs' data-np-via={via}>
      {text}
    </span>
  );
}

export function ActivityRow({
  activity,
  statusCatalog,
  agentName,
}: {
  readonly activity: IssueActivity;
  readonly statusCatalog: readonly StatusCatalogEntry[];
  readonly agentName: ActivityTimelineProps['agentName'];
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const label = activityLabel(activity.action);
  const actor =
    activity.actorName ??
    (activity.actorType === 'agent' ? agentName(activity.actorId) : null) ??
    (activity.actorType === 'system'
      ? t('np.activity.system')
      : t('np.common.unknown'));
  const change = activityChange(activity.details);
  const via = activityVia(activity.details);
  return (
    <div className='flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-muted-foreground'>
      <CircleDotIcon className='size-3.5 shrink-0' aria-hidden='true' />
      <NpActorAvatar type={activity.actorType} name={actor} size='xs' />
      <span className='font-medium text-foreground'>{actor}</span>
      {via ? <ViaMarker via={via} activity={activity} /> : null}
      <span>{t(`np.activity.actions.${label}`)}</span>
      {STATUS_CHANGE_LABELS.has(label) && change.to ? (
        <>
          {change.from ? (
            <NpStatusBadge statusKey={change.from} catalog={statusCatalog} />
          ) : null}
          {change.from ? <span aria-hidden='true'>→</span> : null}
          <NpStatusBadge statusKey={change.to} catalog={statusCatalog} />
        </>
      ) : null}
      {label === 'processSelected' ? (
        <SelectedProcess details={activity.details} />
      ) : null}
      {label === 'prMergeRequested' ? (
        <MergedPullRequest details={activity.details} />
      ) : null}
      {label === 'signalReceived' ||
      label === 'signalSuppressed' ||
      label === 'signalResolved' ? (
        <SignalKind details={activity.details} />
      ) : null}
      <time
        dateTime={activity.createdAt}
        title={format.dateTime(activity.createdAt)}
        className='ml-auto text-xs'
      >
        {format.relative(activity.createdAt)}
      </time>
    </div>
  );
}

/** The signal's kind, localized, linking to what it is about (Phase 2 signals). */
function SignalKind({
  details,
}: {
  readonly details: IssueActivity['details'];
}): ReactElement | null {
  const { t } = useTranslation();
  const value = (details ?? {}) as { kind?: unknown; url?: unknown };
  if (typeof value.kind !== 'string') return null;
  const label = t(`np.signals.kinds.${value.kind}.label`, {
    defaultValue: value.kind,
  });
  return typeof value.url === 'string' && value.url.startsWith('https://') ? (
    <a
      href={value.url}
      target='_blank'
      rel='noreferrer'
      className='text-foreground underline-offset-4 hover:underline'
    >
      {label}
    </a>
  ) : (
    <span className='text-foreground'>{label}</span>
  );
}

/** `repo#12` of a merge request (NP-85). */
function MergedPullRequest({
  details,
}: {
  readonly details: IssueActivity['details'];
}): ReactElement | null {
  const value = (details ?? {}) as { repo?: unknown; number?: unknown };
  if (typeof value.repo !== 'string' || typeof value.number !== 'number')
    return null;
  return (
    <span className='font-mono text-xs text-foreground'>
      {value.repo}#{value.number}
    </span>
  );
}

function RunRow({
  run,
  agentName,
}: {
  readonly run: RunSummary;
  readonly agentName: ActivityTimelineProps['agentName'];
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const name =
    run.agentName ?? agentName(run.agentId) ?? t('np.common.unknownAgent');
  const trigger = runTriggerType(run);
  const active =
    run.status === 'running' ||
    run.status === 'dispatched' ||
    run.status === 'queued';
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
  return (
    <div className='flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1 text-sm text-muted-foreground'>
      {active ? (
        <NpPulse />
      ) : (
        <PlayIcon className='size-3.5 shrink-0' aria-hidden='true' />
      )}
      <span className='text-foreground'>
        {t(`np.activity.run.${run.status}`, { name })}
      </span>
      {trigger ? (
        <span className='text-xs'>
          · {t(`np.trigger.${trigger}`, { defaultValue: trigger })}
        </span>
      ) : null}
      {run.status === 'failed' && run.failureReason ? (
        <span className='text-xs text-destructive'>
          ·{' '}
          {t(failureReasonKey(run.failureReason), {
            defaultValue: run.failureReason,
          })}
        </span>
      ) : null}
      <Link
        to={`runs/${encodeURIComponent(run.id)}`}
        className='text-xs underline-offset-4 hover:text-foreground hover:underline'
      >
        {t('np.runs.viewTranscript')}
      </Link>
      <time
        dateTime={at}
        title={format.dateTime(at)}
        className='ml-auto text-xs'
      >
        {format.relative(at)}
      </time>
    </div>
  );
}

/** The process an issue got (iteration 4 §B `process_selected`): the design-first marker, or "Straight to development". */
function SelectedProcess({
  details,
}: {
  readonly details: IssueActivity['details'];
}): ReactElement | null {
  const { t } = useTranslation();
  const value = details?.process ?? details?.to;
  if (value === 'design_first') {
    return <NpProcessBadge issue={{ process: 'design_first' }} />;
  }
  if (value === 'direct') {
    return <NpTag tone='grey'>{t('np.process.choices.direct')}</NpTag>;
  }
  return null;
}
