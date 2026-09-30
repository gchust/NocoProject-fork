import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement, ReactNode } from 'react';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpStatusBadge } from '@/components/np-badges';
import { NpMarkdown } from '@/components/np-markdown';
import { Skeleton } from '@/components/ui/skeleton';

import { failureReasonKey, useNpFormatters } from '../format.js';
import { ProposalsCard } from '../issues/detail/proposals-card.js';
import { PullRequestCard } from '../issues/detail/pull-requests-section.js';
import type { AgentListItem, IssueDetail, InboxItem } from '../types.js';
import { latestAgentComment, latestFinishedRun } from './decision-model.js';
import { DesignProposalContent } from './proposal-content.js';
import { KnowledgeProposalContent } from './knowledge-content.js';
import { RuntimeUpgradeContent } from './runtime-upgrade-content.js';

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The thing being decided, in full (nocosolution/guidelines/frontend-standard.md §S3, the lesson taken from NocoSupport): never an
 * "accept" button without what is being accepted. Shared by the inbox's detail pane and the issue page's decision
 * card. `detail` is the issue (the same cached query the issue page reads); while it loads the blocks that need it
 * show skeletons, the ones that come from the item itself render at once.
 */
export function DecisionContent({
  item,
  detail,
  agents,
  detailLoading,
}: {
  readonly item: InboxItem;
  readonly detail: IssueDetail | undefined;
  readonly agents: readonly AgentListItem[];
  readonly detailLoading: boolean;
}): ReactElement | null {
  const type = item.type as string;
  switch (type) {
    case 'review_requested':
    case 'agent_blocked':
      return (
        <DeliveryContent
          blocked={type === 'agent_blocked'}
          item={item}
          detail={detail}
          loading={detailLoading}
        />
      );
    case 'approval_pending':
      return <ApprovalContent item={item} detail={detail} />;
    case 'proposal_pending':
      return detail ? (
        <ProposalsCard
          issueId={detail.issue.id}
          proposals={detail.proposals}
          agents={agents}
          embedded
        />
      ) : detailLoading ? (
        <Skeleton className='h-20 w-full' />
      ) : null;
    case 'knowledge_proposal':
      return <KnowledgeProposalContent item={item} />;
    case 'pr_review':
      return <PrContent item={item} detail={detail} loading={detailLoading} />;
    case 'design_review':
      return (
        <DesignProposalContent
          item={item}
          detail={detail}
          loading={detailLoading}
        />
      );
    case 'runtime_upgrade_required':
      return <RuntimeUpgradeContent item={item} />;
    default:
      return <NoticeContent item={item} />;
  }
}

function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd className='flex min-w-0 flex-wrap items-center gap-1.5'>
        {children}
      </dd>
    </>
  );
}

/** The agent's delivery note (or blocking reason) in full, the run's result and the linked pull requests. */
function DeliveryContent({
  blocked,
  item,
  detail,
  loading,
}: {
  readonly blocked: boolean;
  readonly item: InboxItem;
  readonly detail: IssueDetail | undefined;
  readonly loading: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const comment = latestAgentComment(detail);
  const run = latestFinishedRun(detail);
  const pullRequests = detail?.pullRequests ?? [];
  if (!detail && loading) {
    return (
      <div className='space-y-2'>
        <Skeleton className='h-4 w-40' />
        <Skeleton className='h-24 w-full' />
      </div>
    );
  }
  const author =
    comment?.authorName ?? item.actorName ?? t('np.common.unknownAgent');
  return (
    <div className='space-y-3'>
      {comment ? (
        <article className='space-y-2'>
          <header className='flex flex-wrap items-center gap-2 text-sm'>
            <NpActorAvatar type='agent' name={author} size='xs' />
            <span className='font-medium'>{author}</span>
            <span className='text-xs text-agent'>
              {blocked
                ? t('np.decision.delivery.blockedNote')
                : t('np.decision.delivery.note')}
            </span>
            <time
              className='ml-auto text-xs text-muted-foreground'
              dateTime={comment.createdAt}
              title={format.dateTime(comment.createdAt)}
            >
              {format.relative(comment.createdAt)}
            </time>
          </header>
          <div className='max-h-96 overflow-y-auto rounded-md border bg-muted/40 px-4 py-3'>
            <NpMarkdown content={comment.content} />
          </div>
        </article>
      ) : (
        <p className='text-sm text-muted-foreground'>
          {t('np.decision.delivery.noNote')}
        </p>
      )}
      {run ? (
        <p className='text-xs text-muted-foreground'>
          {run.status === 'failed' && run.failureReason
            ? t('np.decision.delivery.runFailed', {
                reason: t(failureReasonKey(run.failureReason), {
                  defaultValue: run.failureReason,
                }),
              })
            : run.resultSummary
              ? t('np.decision.delivery.runResult', {
                  summary: run.resultSummary,
                })
              : t('np.decision.delivery.runDone', {
                  when: format.relative(run.finishedAt ?? run.createdAt),
                })}
        </p>
      ) : null}
      {pullRequests.length > 0 && detail ? (
        <ul className='space-y-2' aria-label={t('np.pullRequests.title')}>
          {pullRequests.map((pr) => (
            <PullRequestCard key={pr.id} issueId={detail.issue.id} pr={pr} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The status change that waits: from → to, who asked, who may decide, since when. */
function ApprovalContent({
  item,
  detail,
}: {
  readonly item: InboxItem;
  readonly detail: IssueDetail | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const payload = item.payload ?? {};
  const requestId =
    text(payload.requestId) ??
    text(payload.approvalId) ??
    text(payload.approvalRequestId);
  const approval = detail?.approvals.find((entry) => entry.id === requestId);
  const from = approval?.fromStatus ?? text(payload.fromStatus);
  const to = approval?.toStatus ?? text(payload.toStatus);
  const requester =
    approval?.requestedByName ??
    text(payload.requestedByName) ??
    item.actorName;
  const catalog = detail?.statusCatalog;
  return (
    <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm'>
      {to ? (
        <Row label={t('np.decision.approval.change')}>
          {from ? <NpStatusBadge statusKey={from} catalog={catalog} /> : null}
          {from ? <span aria-hidden='true'>→</span> : null}
          <NpStatusBadge statusKey={to} catalog={catalog} />
        </Row>
      ) : null}
      {requester ? (
        <Row label={t('np.decision.approval.requester')}>
          <NpActorAvatar
            type={approval?.requestedByType ?? item.actorType ?? 'user'}
            name={requester}
            size='xs'
            showName
          />
        </Row>
      ) : null}
      {approval?.approverNames && approval.approverNames.length > 0 ? (
        <Row label={t('np.decision.approval.approvers')}>
          <span>{approval.approverNames.join('、')}</span>
        </Row>
      ) : null}
      <Row label={t('np.decision.approval.since')}>
        <time
          dateTime={approval?.createdAt ?? item.createdAt}
          title={format.dateTime(approval?.createdAt ?? item.createdAt)}
        >
          {format.relative(approval?.createdAt ?? item.createdAt)}
        </time>
      </Row>
    </dl>
  );
}

function PrContent({
  item,
  detail,
  loading,
}: {
  readonly item: InboxItem;
  readonly detail: IssueDetail | undefined;
  readonly loading: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  const payload = item.payload ?? {};
  const number = typeof payload.number === 'number' ? payload.number : null;
  const pr =
    detail?.pullRequests.find(
      (entry) =>
        entry.id === text(payload.pullRequestId) || entry.number === number,
    ) ?? null;
  if (pr && detail) {
    return (
      <ul aria-label={t('np.pullRequests.title')}>
        {/* The decision's action bar carries the merge. */}
        <PullRequestCard issueId={detail.issue.id} pr={pr} showMerge={false} />
      </ul>
    );
  }
  if (loading) return <Skeleton className='h-20 w-full' />;
  const url = text(payload.url);
  const repo = text(payload.repo);
  return url ? (
    <a
      href={url}
      target='_blank'
      rel='noreferrer'
      className='font-mono text-sm hover:underline'
    >
      {repo && number !== null ? `${repo}#${number}` : url}
    </a>
  ) : null;
}

/** A notification: the quoted comment when there is one. */
function NoticeContent({
  item,
}: {
  readonly item: InboxItem;
}): ReactElement | null {
  const excerpt = text(item.payload?.excerpt);
  const comment = text(item.payload?.comment);
  const quote = excerpt ?? comment;
  if (!quote) return null;
  return (
    <blockquote className='rounded-md border-l-2 bg-muted/40 px-4 py-3 text-sm wrap-anywhere'>
      <NpMarkdown content={quote} />
    </blockquote>
  );
}
