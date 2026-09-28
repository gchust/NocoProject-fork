import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ShieldCheckIcon, XIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { NpStatusBadge } from '@/components/np-badges';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

import { fetchMembers } from '../../api-collab.js';
import { type ApprovalDecision, decideApproval } from '../../api-iter2.js';
import {
  approverNames,
  canDecideApproval,
  pendingApprovals,
} from '../../approval-model.js';
import { npKeys } from '../../constants.js';
import { useNpFormatters } from '../../format.js';
import type { ApprovalRequest, StatusCatalogEntry } from '../../types.js';
import { useDetailMutation } from './use-detail-mutation.js';

/**
 * Pending approvals on the issue (iteration 2 §D, a stand-in until NocoBase ships approvals): the status change that
 * waits, who asked and who may decide. Approve applies the change on the approvers' behalf; reject keeps the status.
 * Only listed approvers see the buttons; everyone else sees who the request waits for.
 */
export function ApprovalsCard({
  issueId,
  approvals,
  catalog,
  meUserId,
}: {
  readonly issueId: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly catalog: readonly StatusCatalogEntry[];
  readonly meUserId: string | undefined;
}): ReactElement | null {
  const pending = pendingApprovals(approvals);
  if (pending.length === 0) return null;
  return (
    <div className='space-y-2'>
      {pending.map((approval) => (
        <ApprovalItem
          key={approval.id}
          issueId={issueId}
          approval={approval}
          catalog={catalog}
          meUserId={meUserId}
        />
      ))}
    </div>
  );
}

export function ApprovalItem({
  issueId,
  approval,
  catalog,
  meUserId,
}: {
  readonly issueId: string;
  readonly approval: ApprovalRequest;
  readonly catalog?: readonly StatusCatalogEntry[];
  readonly meUserId: string | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const format = useNpFormatters();
  const [comment, setComment] = useState('');
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const decide = useDetailMutation(
    issueId,
    (decision: ApprovalDecision) =>
      decideApproval(api, approval.id, decision, comment.trim() || undefined),
    {
      success: (_, decision) =>
        decision === 'approve'
          ? t('np.approvals.approved')
          : t('np.approvals.rejected'),
      alsoInvalidate: [npKeys.approvals, npKeys.issues, npKeys.inbox],
    },
  );
  const allowed = canDecideApproval(approval, meUserId);
  const requester =
    approval.requestedByName ??
    members.data?.find((member) => member.userId === approval.requestedById)
      ?.name ??
    t('np.common.unknown');

  return (
    <article
      className='space-y-3 rounded-lg border bg-card p-4 text-card-foreground'
      aria-label={t('np.approvals.cardLabel')}
      data-testid='np-approval-card'
    >
      <div className='flex flex-wrap items-center gap-2 text-sm'>
        <ShieldCheckIcon
          className='size-4 text-muted-foreground'
          aria-hidden='true'
        />
        <span className='font-medium'>{t('np.approvals.pendingTitle')}</span>
        <NpStatusBadge statusKey={approval.fromStatus} catalog={catalog} />
        <span aria-hidden='true'>→</span>
        <NpStatusBadge statusKey={approval.toStatus} catalog={catalog} />
      </div>
      <dl className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground'>
        <dt>{t('np.approvals.requester')}</dt>
        <dd className='text-foreground'>
          {requester}
          {approval.requestedByType === 'agent'
            ? ` · ${t('np.executor.agentMarker')}`
            : ''}
          {' · '}
          <time dateTime={approval.createdAt}>
            {format.relative(approval.createdAt)}
          </time>
        </dd>
        <dt>{t('np.approvals.approvers')}</dt>
        <dd className='text-foreground'>
          {approverNames(approval, members.data).join(
            t('np.comment.nameSeparator'),
          )}
        </dd>
      </dl>
      {allowed ? (
        <div className='space-y-2'>
          <Textarea
            value={comment}
            rows={2}
            aria-label={t('np.approvals.comment')}
            placeholder={t('np.approvals.commentPlaceholder')}
            disabled={decide.isPending}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className='flex justify-end gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={decide.isPending}
              onClick={() => decide.mutate('reject')}
            >
              <XIcon data-icon='inline-start' />
              {t('np.approvals.reject')}
            </Button>
            <Button
              size='sm'
              disabled={decide.isPending}
              onClick={() => decide.mutate('approve')}
            >
              {decide.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <CheckIcon data-icon='inline-start' />
              )}
              {t('np.approvals.approve')}
            </Button>
          </div>
        </div>
      ) : (
        <p className='text-xs text-muted-foreground'>
          {t('np.approvals.waiting')}
        </p>
      )}
    </article>
  );
}
