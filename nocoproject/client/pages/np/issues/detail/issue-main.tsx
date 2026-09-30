import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { CornerLeftUpIcon, PaperclipIcon, PlusIcon } from 'lucide-react';
import { type ReactElement, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { NpStatusBadge } from '@/components/np-badges';
import { NpLiveRun } from '@/components/np-live';
import type { NpRichTextHandle } from '@/components/np-rich-text-editor';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

import { fetchAttachments } from '../../api-attachments.js';
import { fetchMembers } from '../../api-collab.js';
import { ACTIVE_RUN_STATUSES, npKeys } from '../../constants.js';
import type {
  AgentListItem,
  InboxItem,
  IssueComment,
  IssueDetail,
  Me,
} from '../../types.js';
import { ActivityTimeline } from './activity-timeline.js';
import { ApprovalsCard } from './approvals-card.js';
import { AttachmentsSection } from './attachments-section.js';
import { CommentComposer } from './comment-composer.js';
import { DecisionSection } from './decision-section.js';
import { DependenciesSection } from './dependencies-section.js';
import { IssueDescription, IssueTitle } from './issue-content.js';
import { ProposalsCard } from './proposals-card.js';
import { PullRequestsSection } from './pull-requests-section.js';
import { SubtasksSection } from './subtasks-section.js';
import { commentTag } from '../../api-iter4.js';
import { canEditIssue } from '../../permissions.js';
import { useWorkspaceViewer } from '../../use-workspace-viewer.js';
import { NpProcessBadge } from '../process-fields.js';
import { buildTimeline, mergeActivities } from './timeline.js';
import { useIssueDecisions } from './use-issue-decisions.js';
import { useOlderActivities } from './use-older-activities.js';
import { useRevealSentComment } from './use-reveal-sent-comment.js';
import { usePmContextSource } from '../../pm/assistant/pm-assistant.js';
import { AskPmButton } from '../../pm/assistant/pm-launchers.js';
import { sourceAttribute } from '../../pm/context/pm-context-model.js';

/**
 * What the decision section already shows, so the cards below do not repeat it: the approvals it covers, and whether
 * it holds the executor proposals.
 */
function coveredByDecisions(decisions: readonly InboxItem[]): {
  readonly approvalIds: ReadonlySet<string>;
  readonly proposals: boolean;
} {
  const approvalIds = new Set<string>();
  let proposals = false;
  for (const item of decisions) {
    if (item.resolvedAt !== null) continue;
    if (item.type === 'approval_pending') {
      const payload = item.payload ?? {};
      for (const key of ['requestId', 'approvalId', 'approvalRequestId']) {
        const value = payload[key];
        if (typeof value === 'string' && value) approvalIds.add(value);
      }
    }
    if (item.type === 'proposal_pending') proposals = true;
  }
  return { approvalIds, proposals };
}

/**
 * The main column (nocosolution/guidelines/frontend-standard.md §S3): parent link, title, the meta line (identifier, status, project, the
 * live run), "Waiting for you", description, attachments (NP-78; only with files or once revealed), pending approvals and executor proposals not already in a decision, then pull
 * requests,
 * sub-issues and dependencies as cards, the activity timeline (older activities on demand, virtualized when long,
 * iteration 3 §D / §H 8) and the comment composer pinned under it (⌘Enter sends). Without `issues/edit` (NP-161,
 * `canEditIssue`) the title, description, composer, replies, and the subtask, dependency and attachment write
 * controls do not render — pull requests are governed by their own scope, not this one.
 */
export function IssueMain({
  detail,
  agents,
  me,
}: {
  readonly detail: IssueDetail;
  readonly agents: readonly AgentListItem[];
  readonly me?: Me;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const { issue } = detail;
  const { viewer } = useWorkspaceViewer();
  const canEdit = canEditIssue(viewer);
  const editorRef = useRef<NpRichTextHandle>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<IssueComment | null>(null);
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });

  const names = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const agentName = (agentId: string | null | undefined): string | null =>
    agentId ? (names.get(agentId) ?? null) : null;
  const userName = (userId: string): string =>
    members.data?.find((member) => member.userId === userId)?.name ??
    (userId === me?.userId ? me.name : userId);

  const older = useOlderActivities(issue.id, detail.activitiesNextCursor);
  const timeline = useMemo(
    () =>
      buildTimeline({
        ...detail,
        activities: mergeActivities(older.activities, detail.activities),
      }),
    [detail, older.activities],
  );
  const revealSent = useRevealSentComment(composerRef, issue.id, timeline);
  const replyToName = replyTo
    ? (replyTo.authorName ??
      (replyTo.authorType === 'agent' ? agentName(replyTo.authorId) : null))
    : null;

  const [revealed, setRevealed] = useState<
    ReadonlySet<'prs' | 'dependencies' | 'attachments'>
  >(() => new Set());
  const reveal = (section: 'prs' | 'dependencies' | 'attachments') =>
    setRevealed((current) => new Set(current).add(section));
  const attachments = useQuery({
    queryKey: npKeys.issueAttachments(issue.id),
    queryFn: () => fetchAttachments(api, issue.id),
  });
  const attachmentList = attachments.data ?? [];
  const showAttachments =
    attachmentList.length > 0 || revealed.has('attachments');
  const showPrs = detail.pullRequests.length > 0 || revealed.has('prs');
  const showDependencies =
    detail.blockedBy.length > 0 ||
    detail.blocks.length > 0 ||
    revealed.has('dependencies');
  const decisions = useIssueDecisions(issue.id);
  // NP-185: the issue is the project manager's page context while it is open.
  const pmObject = {
    type: 'issue' as const,
    id: issue.id,
    label: issue.identifier
      ? `${issue.identifier} ${issue.title}`
      : issue.title,
  };
  usePmContextSource(pmObject);
  const covered = coveredByDecisions(decisions);
  const live = detail.runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const project = detail.project;

  return (
    <>
      <div className='flex-1'>
        <div
          className='w-full space-y-6 px-6 py-6 md:px-8'
          data-pm-source={sourceAttribute('issue', issue.id)}
        >
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Breadcrumbs />
              <AskPmButton object={pmObject} variant='ghost' />
            </div>
            {detail.parent ? (
              <Link
                to={`../${encodeURIComponent(detail.parent.id)}`}
                relative='path'
                className='inline-flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground'
              >
                <CornerLeftUpIcon
                  className='size-3.5 shrink-0'
                  aria-hidden='true'
                />
                <span className='shrink-0'>{t('np.issue.parent')}</span>
                <span className='shrink-0 font-mono'>
                  {detail.parent.identifier}
                </span>
                <span className='truncate'>{detail.parent.title}</span>
              </Link>
            ) : null}
            <IssueTitle issue={issue} canEdit={canEdit} />
            <div className='flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground'>
              <span className='font-mono text-xs'>{issue.identifier}</span>
              <NpStatusBadge
                statusKey={issue.statusKey}
                catalog={detail.statusCatalog}
              />
              <NpProcessBadge issue={issue} />
              {project ? (
                <Link
                  to={`/projects/${encodeURIComponent(project.id)}`}
                  className='truncate hover:text-foreground hover:underline'
                >
                  {project.name}
                </Link>
              ) : null}
              {live ? (
                <NpLiveRun
                  className='sm:ml-auto'
                  agentName={
                    live.agentName ??
                    agentName(live.agentId) ??
                    t('np.common.unknownAgent')
                  }
                  status={
                    live.status as
                      'queued' | 'dispatched' | 'running' | 'deferred'
                  }
                  since={live.startedAt ?? live.createdAt}
                  to={`runs/${encodeURIComponent(live.id)}`}
                />
              ) : null}
            </div>
          </div>
          <DecisionSection
            detail={detail}
            agents={agents}
            decisions={decisions}
          />
          <IssueDescription issue={issue} agents={agents} canEdit={canEdit} />
          {showAttachments ? (
            <AttachmentsSection
              issueId={issue.id}
              attachments={attachmentList}
              initialUploading={attachmentList.length === 0}
              canEdit={canEdit}
            />
          ) : null}
          <ApprovalsCard
            issueId={issue.id}
            approvals={detail.approvals.filter(
              (approval) => !covered.approvalIds.has(approval.id),
            )}
            catalog={detail.statusCatalog}
            meUserId={me?.userId}
          />
          {covered.proposals ? null : (
            <ProposalsCard
              issueId={issue.id}
              proposals={detail.proposals}
              agents={agents}
            />
          )}
          {/* Optional blocks take no room while empty (nocosolution/guidelines/frontend-standard.md §3.4): sub-issues fold into one
              row, pull requests and blockers appear from the "Add" chips or once they have content. */}
          {showPrs ? (
            <div className='rounded-lg border bg-card p-4 text-card-foreground'>
              <PullRequestsSection
                issueId={issue.id}
                pullRequests={detail.pullRequests}
                initialLinking={
                  revealed.has('prs') && detail.pullRequests.length === 0
                }
              />
            </div>
          ) : null}
          {detail.subtasks.length > 0 ? (
            <div className='rounded-lg border bg-card p-4 text-card-foreground'>
              <SubtasksSection
                issueId={issue.id}
                issueLabel={pmObject.label}
                subtasks={detail.subtasks}
                catalog={detail.statusCatalog}
                canEdit={canEdit}
              />
            </div>
          ) : (
            <SubtasksSection
              issueId={issue.id}
              issueLabel={pmObject.label}
              subtasks={detail.subtasks}
              catalog={detail.statusCatalog}
              canEdit={canEdit}
            />
          )}
          {showDependencies ? (
            <div className='rounded-lg border bg-card p-4 text-card-foreground'>
              <DependenciesSection detail={detail} canEdit={canEdit} />
            </div>
          ) : null}
          {!showPrs || (canEdit && (!showDependencies || !showAttachments)) ? (
            <div className='flex flex-wrap items-center gap-2 text-sm text-muted-foreground'>
              <span>{t('np.issueAdd.label')}</span>
              {!showAttachments && canEdit ? (
                <Button
                  variant='outline'
                  size='sm'
                  className='rounded-full'
                  disabled={attachments.isPending}
                  onClick={() => reveal('attachments')}
                >
                  <PaperclipIcon data-icon='inline-start' />
                  {t('np.issueAdd.attachment')}
                </Button>
              ) : null}
              {!showDependencies && canEdit ? (
                <Button
                  variant='outline'
                  size='sm'
                  className='rounded-full'
                  onClick={() => reveal('dependencies')}
                >
                  <PlusIcon data-icon='inline-start' />
                  {t('np.issueAdd.dependency')}
                </Button>
              ) : null}
              {!showPrs ? (
                <Button
                  variant='outline'
                  size='sm'
                  className='rounded-full'
                  onClick={() => reveal('prs')}
                >
                  <PlusIcon data-icon='inline-start' />
                  {t('np.issueAdd.pullRequest')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <section className='space-y-4' aria-labelledby='np-activity-heading'>
            <div className='flex items-center justify-between gap-2'>
              <h2
                id='np-activity-heading'
                className='font-heading text-sm font-semibold'
              >
                {t('np.activity.title')}
              </h2>
              {older.hasMore ? (
                <Button
                  variant='ghost'
                  size='sm'
                  disabled={older.loading}
                  onClick={older.loadMore}
                >
                  {older.loading ? <Spinner data-icon='inline-start' /> : null}
                  {t('np.activity.loadOlder')}
                </Button>
              ) : null}
            </div>
            <ActivityTimeline
              entries={timeline}
              statusCatalog={detail.statusCatalog}
              issueId={issue.id}
              meUserId={me?.userId}
              agentName={agentName}
              userName={userName}
              replyingToId={replyTo?.id ?? null}
              commentTag={(comment) => commentTag(comment, detail.runs)}
              canReply={canEdit}
              onReply={(comment) => {
                setReplyTo(comment);
                editorRef.current?.focus();
              }}
            />
          </section>
        </div>
      </div>
      {canEdit ? (
        <div
          ref={composerRef}
          className='sticky bottom-0 border-t bg-background/95 backdrop-blur-md'
        >
          <div className='w-full px-6 py-3 md:px-8'>
            <CommentComposer
              issueId={issue.id}
              executor={{ type: issue.executorType, id: issue.executorId }}
              agents={agents}
              agentName={agentName}
              replyTo={replyTo}
              replyToName={replyToName}
              onCancelReply={() => setReplyTo(null)}
              editorRef={editorRef}
              onSent={revealSent}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
