import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { fetchAgents, fetchIssueDetail } from '../../api.js';
import { fetchInbox } from '../../api-inbox.js';
import { npKeys } from '../../constants.js';
import { DecisionContent } from '../../decision/decision-content.js';

/**
 * A `decision.resolve` row shows what is being decided in full, like the inbox does (README §4): the inbox item
 * from the member's open decisions, with its issue. The chosen action and the comment are on the row itself.
 */
export function PmDecisionRow({
  params,
}: {
  readonly params: Record<string, unknown>;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const itemId =
    typeof params.inboxItemId === 'string' ? params.inboxItemId : '';
  const decisions = useQuery({
    // Under `inbox`, so the inbox's realtime refresh reaches it; not the inbox page's (infinite) list key.
    queryKey: [...npKeys.inbox, 'pm-plan', 'open'],
    queryFn: ({ signal }) =>
      fetchInbox(
        api,
        { kind: 'decision', archived: false, resolved: false },
        signal,
      ),
    enabled: itemId !== '',
    retry: false,
  });
  const item = decisions.data?.items.find((entry) => entry.id === itemId);
  const issueId = item?.issueId ?? null;
  const detail = useQuery({
    queryKey: npKeys.issue(issueId ?? ''),
    queryFn: ({ signal }) => fetchIssueDetail(api, issueId ?? '', signal),
    enabled: issueId !== null,
    retry: false,
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
    enabled: item?.type === 'proposal_pending',
  });
  const comment =
    typeof params.comment === 'string' && params.comment
      ? params.comment
      : null;

  return (
    <div className='space-y-2 text-sm'>
      {item ? (
        <div className='space-y-2 rounded-md border bg-card p-2'>
          <p className='font-medium wrap-anywhere'>{item.title}</p>
          <DecisionContent
            item={item}
            detail={detail.data}
            agents={agents.data ?? []}
            detailLoading={issueId !== null && detail.isPending}
          />
        </div>
      ) : decisions.isPending && itemId ? null : (
        <p className='text-xs text-muted-foreground'>
          {t('np.pmAssistant.plan.decisionGone')}
        </p>
      )}
      {comment ? (
        <p className='text-xs'>
          <span className='text-muted-foreground'>
            {t('np.pmAssistant.plan.fields.comment')}:{' '}
          </span>
          {comment}
        </p>
      ) : null}
    </div>
  );
}
