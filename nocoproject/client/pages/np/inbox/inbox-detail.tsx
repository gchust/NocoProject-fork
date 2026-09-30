import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  BotMessageSquareIcon,
  CheckCircle2Icon,
  InboxIcon,
  SquareArrowOutUpRightIcon,
} from 'lucide-react';
import { type ReactElement, type ReactNode, useMemo } from 'react';
import { Link } from 'react-router';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpExecutor, NpStatusBadge } from '@/components/np-badges';
import { NpLiveRun } from '@/components/np-live';
import { NpSectionHeading } from '@/components/np-section';
import { NpEmpty } from '@/components/np-states';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import type { InboxAction } from '../api-inbox.js';
import { fetchAgents, fetchIssueDetail } from '../api.js';
import { ACTIVE_RUN_STATUSES, npKeys } from '../constants.js';
import { DecisionContent } from '../decision/decision-content.js';
import {
  useDecisionSentence,
  useDecisionTitle,
} from '../decision/decision-model.js';
import { InboxTypeIcon } from '../decision/decision-meta.js';
import type { DecisionRunner } from '../decision/use-decision.js';
import { useNpFormatters } from '../format.js';
import { ActivityRow } from '../issues/detail/activity-timeline.js';
import { commentSnippet } from '../issues/detail/timeline.js';
import type { IssueDetail, InboxItem } from '../types.js';
import { DecisionActionsBar } from './decision-actions-bar.js';
import { readInboxActions } from './decision-actions.js';
import { INBOX_ACTION_ICON } from './inbox-icons.js';
import { inboxActionsFor, inboxItemLink, isSettled } from './inbox-model.js';
import {
  usePmAssistant,
  usePmContextSource,
} from '../pm/assistant/pm-assistant.js';

/**
 * The inbox's detail pane (nocosolution/guidelines/frontend-standard.md §S2): everything needed to decide without leaving the inbox.
 * A sticky bar at the top holds what the item is, its title and its actions (the primary action filled, a comment
 * field inline when an action needs one), with read / archive / open-issue icon buttons. Below it: the issue
 * (status, owner, executor, a live run), the thing being decided in full, and the issue's latest activity.
 */
export function InboxDetail({
  item,
  runner,
  busy,
  onBack,
  onAction,
  onOpen,
}: {
  readonly item: InboxItem | null;
  readonly runner: DecisionRunner;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onAction: (item: InboxItem, action: InboxAction) => void;
  readonly onOpen: (item: InboxItem) => void;
}): ReactElement {
  const { t } = useTranslation();
  if (!item) {
    return (
      <div className='flex h-full items-center justify-center p-6'>
        <NpEmpty
          icon={<InboxIcon />}
          title={t('np.inboxPane.nothingSelected')}
          className='border-none bg-transparent'
        />
      </div>
    );
  }
  return (
    <ItemDetail
      key={item.id}
      item={item}
      runner={runner}
      busy={busy}
      onBack={onBack}
      onAction={onAction}
      onOpen={onOpen}
    />
  );
}

function ItemDetail({
  item,
  runner,
  busy,
  onBack,
  onAction,
  onOpen,
}: {
  readonly item: InboxItem;
  readonly runner: DecisionRunner;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onAction: (item: InboxItem, action: InboxAction) => void;
  readonly onOpen: (item: InboxItem) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const title = useDecisionTitle();
  const sentence = useDecisionSentence();
  const issueId = item.issueId;
  const detail = useQuery({
    queryKey: npKeys.issue(issueId ?? ''),
    queryFn: ({ signal }) => fetchIssueDetail(api, issueId ?? '', signal),
    enabled: issueId !== null,
    retry: (count, error) =>
      !(error instanceof ApiClientError && [403, 404].includes(error.status)) &&
      count < 1,
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
    enabled: item.type === 'proposal_pending',
  });
  const settled = isSettled(item);
  const actions = item.kind === 'decision' ? readInboxActions(item) : [];
  const toggles = inboxActionsFor(item);
  const link = inboxItemLink(item);
  const body = sentence(item);
  // NP-185: the selected item is the project manager's page context.
  const pmObject = {
    type: 'inboxItem' as const,
    id: item.id,
    label: item.title,
  };
  usePmContextSource(pmObject);
  const assistant = usePmAssistant();

  return (
    <article
      className='flex min-h-full flex-col'
      aria-labelledby='np-inbox-detail-title'
      data-testid='np-inbox-detail'
    >
      <header className='sticky top-0 z-10 space-y-3 border-b bg-background/95 p-5 backdrop-blur-md md:px-6'>
        <div className='flex items-center gap-2'>
          <Button
            variant='ghost'
            size='icon-sm'
            className='-ml-1.5 lg:hidden'
            aria-label={t('np.inboxPane.back')}
            onClick={onBack}
          >
            <ArrowLeftIcon />
          </Button>
          {settled ? (
            <CheckCircle2Icon
              className='size-4 text-success'
              aria-hidden='true'
            />
          ) : (
            <InboxTypeIcon item={item} />
          )}
          <span className='text-sm font-medium'>{title(item)}</span>
          {settled ? (
            <span className='text-xs text-muted-foreground'>
              {t('np.inbox.resolved')}
            </span>
          ) : null}
          <div className='ml-auto flex items-center gap-0.5'>
            {toggles.map((action) => {
              const Icon = INBOX_ACTION_ICON[action];
              return (
                <IconAction
                  key={action}
                  label={t(`np.inbox.actions.${action}`)}
                  shortcut={action === 'archive' ? 'E' : undefined}
                  disabled={busy}
                  onClick={() => onAction(item, action)}
                >
                  <Icon />
                </IconAction>
              );
            })}
            {assistant.available ? (
              <IconAction
                label={t('np.pmAssistant.ask')}
                onClick={() => assistant.openAssistant({ pin: pmObject })}
              >
                <BotMessageSquareIcon />
              </IconAction>
            ) : null}
            {link ? (
              <IconAction
                label={t('np.inboxPane.openIssue')}
                shortcut='Enter'
                onClick={() => onOpen(item)}
              >
                <SquareArrowOutUpRightIcon />
              </IconAction>
            ) : null}
          </div>
        </div>
        <div className='space-y-1'>
          <h2
            id='np-inbox-detail-title'
            className='font-heading text-lg font-semibold tracking-tight wrap-anywhere'
          >
            {item.title}
          </h2>
          {body ? (
            <p className='text-sm text-muted-foreground wrap-anywhere'>
              {body}
            </p>
          ) : null}
        </div>
        {item.kind === 'decision' && !settled && actions.length > 0 ? (
          <DecisionActionsBar
            actions={actions}
            itemTitle={item.title}
            itemType={item.type}
            pendingKey={runner.pendingKey(item.id)}
            disabled={runner.busy}
            onRun={(action, comment) => runner.run(item, action, comment)}
          />
        ) : null}
      </header>
      <div className='flex-1 space-y-6 p-5 md:px-6'>
        {issueId ? (
          <IssueSummary detail={detail.data} loading={detail.isPending} />
        ) : null}
        <DecisionContent
          item={item}
          detail={detail.data}
          agents={agents.data ?? []}
          detailLoading={issueId !== null && detail.isPending}
        />
        {detail.data ? <RecentActivity detail={detail.data} /> : null}
      </div>
    </article>
  );
}

function IconAction({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side='bottom'>
        {label}
        {shortcut ? <Kbd className='ml-1.5'>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** The issue the item is about: identifier, status, owner, executor, and who is working on it right now. */
function IssueSummary({
  detail,
  loading,
}: {
  readonly detail: IssueDetail | undefined;
  readonly loading: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!detail) {
    return loading ? <Skeleton className='h-9 w-full' /> : null;
  }
  const { issue } = detail;
  const live = detail.runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
  return (
    <div className='flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2 text-sm'>
      <Link
        to={`/issues/${encodeURIComponent(issue.id)}`}
        className='inline-flex min-w-0 items-center gap-2 hover:underline'
      >
        <span className='font-mono text-xs text-muted-foreground'>
          {issue.identifier}
        </span>
        <NpStatusBadge
          statusKey={issue.statusKey}
          catalog={detail.statusCatalog}
        />
      </Link>
      <span className='inline-flex items-center gap-1.5 text-muted-foreground'>
        {t('np.properties.owner')}
        <NpActorAvatar
          type='user'
          name={issue.ownerName ?? '—'}
          size='xs'
          showName
          className='text-foreground'
        />
      </span>
      <span className='inline-flex min-w-0 items-center gap-1.5 text-muted-foreground'>
        {t('np.properties.executor')}
        <span className='text-foreground'>
          <NpExecutor
            type={issue.executorType}
            name={issue.executorName}
            activeRunCount={0}
          />
        </span>
      </span>
      {live ? (
        <NpLiveRun
          className='ml-auto'
          agentName={
            live.agentName ?? issue.executorName ?? t('np.common.unknownAgent')
          }
          status={
            live.status as 'queued' | 'dispatched' | 'running' | 'deferred'
          }
          since={live.startedAt ?? live.createdAt}
          to={`/issues/${encodeURIComponent(issue.id)}/runs/${encodeURIComponent(live.id)}`}
        />
      ) : null}
    </div>
  );
}

/** The issue's latest five events, newest first: activity rows and comments as one-line snippets. */
function RecentActivity({
  detail,
}: {
  readonly detail: IssueDetail;
}): ReactElement | null {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const entries = useMemo(() => {
    const activities = detail.activities.map((activity) => ({
      key: `a:${activity.id}`,
      at: activity.createdAt,
      activity,
      comment: null,
    }));
    const comments = detail.threads
      .flatMap((thread) => [thread.root, ...thread.replies])
      .map((comment) => ({
        key: `c:${comment.id}`,
        at: comment.createdAt,
        activity: null,
        comment,
      }));
    return [...activities, ...comments]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 5);
  }, [detail]);
  if (entries.length === 0) return null;
  return (
    <section className='space-y-3' aria-labelledby='np-inbox-recent-heading'>
      <NpSectionHeading
        id='np-inbox-recent-heading'
        title={t('np.inboxPane.recent')}
      />
      <ol className='space-y-2.5'>
        {entries.map((entry) => (
          <li key={entry.key}>
            {entry.activity ? (
              <ActivityRow
                activity={entry.activity}
                statusCatalog={detail.statusCatalog}
                agentName={() => null}
              />
            ) : entry.comment ? (
              <div className='flex items-center gap-2 px-1 text-sm text-muted-foreground'>
                <NpActorAvatar
                  type={entry.comment.authorType}
                  name={entry.comment.authorName ?? '—'}
                  size='xs'
                />
                <span className='shrink-0 font-medium text-foreground'>
                  {entry.comment.authorName ?? t('np.common.unknown')}
                </span>
                <span className='min-w-0 truncate'>
                  {commentSnippet(entry.comment.content, 90)}
                </span>
                <time
                  dateTime={entry.comment.createdAt}
                  title={format.dateTime(entry.comment.createdAt)}
                  className='ml-auto shrink-0 text-xs'
                >
                  {format.relative(entry.comment.createdAt)}
                </time>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
