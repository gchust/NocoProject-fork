import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BotMessageSquareIcon, Settings2Icon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { NpShortcuts } from '@/components/np-shortcuts';
import { NpDetailSkeleton, NpEmpty, NpLoadError } from '@/components/np-states';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

import { fetchWorkspaceSettings } from '../api-iter2.js';
import { ensurePmConversation } from '../api-iter4.js';
import { fetchAgents, fetchIssueDetail } from '../api.js';
import { npKeys } from '../constants.js';
import { SessionPanel } from '../issues/detail/session-panel.js';
import type { IssuesTopicPayload } from '../types.js';
import { ERROR_PM_NOT_CONFIGURED } from '../types-iter4.js';
import { useRealtimeTopic } from '../use-realtime.js';
import { pmConversationKey, pmNotConfigured } from './pm-model.js';

/**
 * Route `/pm` (iteration 4 §C, "项目经理"): the viewer's conversation with the project manager agent. The server keeps
 * one project-less session issue per person (`GET` / `POST /np/pm/conversation` → `issueId`); the page renders that
 * issue's session panel — the message list and the composer — at full width with no properties column, filling the
 * content area so only the message list scrolls. Without a project manager (`settings.pmAgentId` unset, or the
 * server says so) it shows an empty state that links to 设置.
 */
export default function PmPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <PageContainer className='flex h-full min-h-0 flex-col gap-6 space-y-0'>
      <PageHeader
        title={t('np.pm.title')}
        description={t('np.pm.description')}
        actions={<NpShortcuts showTrigger />}
      />
      <div className='min-h-0 flex-1'>
        <PmConversationView />
      </div>
    </PageContainer>
  );
}

function PmConversationView(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  // Members may read the settings; a 403 leaves the question to the conversation endpoint.
  const settings = useQuery({
    queryKey: npKeys.settings,
    queryFn: () => fetchWorkspaceSettings(api),
    retry: false,
  });
  const configuredKnown = settings.isSuccess || settings.isError;
  const unset = settings.isSuccess && pmNotConfigured(settings.data);
  const conversation = useQuery({
    queryKey: pmConversationKey,
    queryFn: ({ signal }) => ensurePmConversation(api, signal),
    enabled: configuredKnown && !unset,
    retry: (count, error) =>
      !(error instanceof ApiClientError && error.status < 500) && count < 2,
  });

  if (!configuredKnown) return <NpDetailSkeleton />;
  const refused =
    conversation.error instanceof ApiClientError &&
    (conversation.error.code === ERROR_PM_NOT_CONFIGURED ||
      conversation.error.status === 409 ||
      conversation.error.status === 400);
  if (
    unset ||
    refused ||
    (conversation.isSuccess && !conversation.data.issueId)
  ) {
    return <PmNotConfigured />;
  }
  if (conversation.isError) {
    return (
      <NpLoadError
        title={t('np.pm.loadFailed')}
        error={conversation.error}
        onRetry={() => void conversation.refetch()}
      />
    );
  }
  const issueId = conversation.data?.issueId;
  if (!issueId) return <NpDetailSkeleton />;
  return <PmChat issueId={issueId} />;
}

function PmNotConfigured(): ReactElement {
  const { t } = useTranslation();
  return (
    <NpEmpty
      icon={<BotMessageSquareIcon />}
      title={t('np.pm.emptyTitle')}
      description={t('np.pm.emptyDescription')}
      action={
        <Button
          variant='outline'
          nativeButton={false}
          render={<Link to='/config/general' />}
        >
          <Settings2Icon data-icon='inline-start' />
          {t('np.pm.openSettings')}
        </Button>
      }
    />
  );
}

/** The conversation itself; it owns the `np:issues` subscription, since no issue list sits underneath this page. */
function PmChat({ issueId }: { readonly issueId: string }): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: npKeys.issue(issueId),
    queryFn: ({ signal }) => fetchIssueDetail(api, issueId, signal),
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  useRealtimeTopic<IssuesTopicPayload>('np:issues', (payload) => {
    if (!payload || payload.issueId === issueId) {
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
    }
  });

  if (detail.isError && !detail.data) {
    return (
      <NpLoadError
        title={t('np.pm.loadFailed')}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  if (!detail.data) return <NpDetailSkeleton />;
  return (
    <SessionPanel
      detail={detail.data}
      agents={agents.data ?? []}
      placeholder={t('np.pm.placeholder')}
      fill
    />
  );
}
