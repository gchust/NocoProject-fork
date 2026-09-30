import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useParams,
  useResolvedPath,
} from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { NpDetailLayout } from '@/components/np-detail-layout';
import { NpDetailSkeleton } from '@/components/np-states';
import { RouteChildPage } from '@/components/route-child-page';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { fetchAgents, fetchIssueDetail, fetchMe } from '../../api.js';
import { npKeys } from '../../constants.js';
import { detailRefetchInterval } from '../../detail-normalize.js';
import type { AgentListItem, IssueDetail, Me } from '../../types.js';
import { IssueMain } from './issue-main.js';
import { PropertiesPanel } from './properties-panel.js';

/**
 * Route `/issues/:issueId`: a covering child page over the issue list, so the list keeps its filters and scroll.
 * Main column (title, description, activity, composer) beside a fixed 20rem properties column with the execution
 * log (§H 3), stacked on narrow screens. The transcript dialog (`runs/:runId`) renders in the outlet beside the layer.
 *
 * The detail refreshes through the `np:issues` subscription owned by the list page underneath, and polls while a run
 * is queued or working (`detailRefetchInterval`) so a dropped realtime connection does not leave it stale.
 *
 * An identifier in the URL (`/issues/NP-12`, as inbox actions link) is replaced by the issue id: every mutation and
 * realtime refresh targets `npKeys.issue(issue.id)`, so a detail cached under the identifier would never show a save
 * and its next edit would send a stale revision (NP-127).
 */
export default function IssueDetailPage(): ReactElement {
  const { issueId = '' } = useParams();
  return (
    <>
      <RouteChildPage>
        <IssueDetailView key={issueId} issueId={issueId} />
      </RouteChildPage>
      <Outlet />
    </>
  );
}

function IssueDetailView({
  issueId,
}: {
  readonly issueId: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const location = useLocation();
  const matched = useResolvedPath('.');

  const detail = useQuery({
    queryKey: npKeys.issue(issueId),
    queryFn: async ({ signal }) => {
      const loaded = await fetchIssueDetail(api, issueId, signal);
      // Opened by identifier: seed the id key so the canonical page below renders without reloading.
      if (loaded.issue.id !== issueId)
        queryClient.setQueryData(npKeys.issue(loaded.issue.id), loaded);
      return loaded;
    },
    refetchInterval: (query) => detailRefetchInterval(query.state.data),
    retry: (count, error) =>
      !(error instanceof ApiClientError && [403, 404].includes(error.status)) &&
      count < 2,
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });

  if (detail.isError && !detail.data) {
    const status =
      detail.error instanceof ApiClientError ? detail.error.status : undefined;
    return (
      <div className='space-y-4 p-6 md:p-8'>
        <Breadcrumbs />
        <Alert variant='destructive'>
          <AlertCircleIcon />
          <AlertTitle>{t('np.issue.loadFailed')}</AlertTitle>
          <AlertDescription>
            {status === 404
              ? t('np.issue.notFound')
              : status === 403
                ? t('np.common.forbidden')
                : t('np.common.requestFailed')}
          </AlertDescription>
          <AlertAction>
            {status === 404 || status === 403 ? (
              <Button
                variant='outline'
                size='sm'
                nativeButton={false}
                render={<Link to='..' relative='path' />}
              >
                {t('np.issue.backToList')}
              </Button>
            ) : (
              <Button
                variant='outline'
                size='sm'
                onClick={() => void detail.refetch()}
              >
                {t('status.retry')}
              </Button>
            )}
          </AlertAction>
        </Alert>
      </div>
    );
  }

  if (!detail.data) return <NpDetailSkeleton />;

  // A project manager conversation is not an issue page (NP-185): it opens as the conversation.
  if (detail.data.issue.originType === 'pm') {
    return (
      <Navigate
        replace
        to={`/pm/${encodeURIComponent(detail.data.issue.id)}`}
      />
    );
  }

  const canonicalId = detail.data.issue.id;
  if (canonicalId !== issueId) {
    // Keep any child route (`runs/:runId`) and the query string.
    const base = matched.pathname.replace(/[^/]+$/, '');
    const rest = location.pathname.slice(matched.pathname.length);
    return (
      <Navigate
        replace
        to={`${base}${encodeURIComponent(canonicalId)}${rest}${location.search}${location.hash}`}
      />
    );
  }

  return (
    <IssueLayout detail={detail.data} agents={agents.data ?? []} me={me.data} />
  );
}

function IssueLayout({
  detail,
  agents,
  me,
}: {
  readonly detail: IssueDetail;
  readonly agents: readonly AgentListItem[];
  readonly me: Me | undefined;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <NpDetailLayout
      main={<IssueMain detail={detail} agents={agents} me={me} />}
      aside={<PropertiesPanel detail={detail} agents={agents} me={me} />}
      asideLabel={t('np.properties.title')}
    />
  );
}
