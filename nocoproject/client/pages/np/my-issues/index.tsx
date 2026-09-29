import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

import { NpRouteTabs } from '@/components/np-route-tabs';
import { NpShortcuts } from '@/components/np-shortcuts';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { useIsParentEntry } from '@/components/use-default-tab';

import { canEditIssue } from '../permissions.js';
import { useWorkspaceViewer } from '../use-workspace-viewer.js';
import { NewIssueButtonAbsolute } from './new-issue-link.js';

/**
 * Route `/my-issues` (§G, "My issues"): the issue list and board filtered to the viewer, with two tabs that are child
 * routes — `owned` (I own, owner = me) and `executing` (I execute, executor = me). The bare URL redirects to
 * `owned`, keeping the query string; the view and the other filters live in the query string as on `/issues`.
 */
export default function MyIssuesPage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const isParentEntry = useIsParentEntry();
  const { viewer } = useWorkspaceViewer();
  const canEdit = canEditIssue(viewer);
  if (isParentEntry) {
    return (
      <Navigate replace to={{ pathname: 'owned', search: location.search }} />
    );
  }
  return (
    <PageContainer className='flex h-full min-h-0 flex-col gap-6 space-y-0'>
      <PageHeader
        title={t('np.myIssues.title')}
        description={t('np.myIssues.description')}
        actions={
          <>
            <NpShortcuts showTrigger canCreate={canEdit} />
            <NewIssueButtonAbsolute canEdit={canEdit} />
          </>
        }
      />
      <NpRouteTabs
        label={t('np.myIssues.tabsLabel')}
        tabs={[
          { path: 'owned', label: t('np.myIssues.tabs.owned') },
          { path: 'executing', label: t('np.myIssues.tabs.executing') },
        ]}
      />
      <div className='min-h-0 flex-1'>
        <Outlet />
      </div>
    </PageContainer>
  );
}
