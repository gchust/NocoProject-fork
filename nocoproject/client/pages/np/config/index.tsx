import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

import { NpRouteTabs } from '@/components/np-route-tabs';
import { NpShortcuts } from '@/components/np-shortcuts';
import { NpListSkeleton } from '@/components/np-states';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { useIsParentEntry } from '@/components/use-default-tab';

import { visibleConfigTabs } from './config-model.js';
import { useWorkspaceViewer } from '../use-workspace-viewer.js';

/**
 * Route `/config` (§G, "设置"): the workspace settings in the front end instead of the system settings shell. Tabs
 * are child routes — 通用, 成员, 工作流模板, 标签 and (owner/admin) GitHub. Every member opens the page; owner/admin
 * edit, the others read. The bare URL redirects to `general` once the viewer's role is known.
 */
export default function ConfigPage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const isParentEntry = useIsParentEntry();
  const viewer = useWorkspaceViewer();
  if (isParentEntry) {
    return viewer.isLoading ? (
      <PageContainer>
        <NpListSkeleton />
      </PageContainer>
    ) : (
      <Navigate replace to={{ pathname: 'general', search: location.search }} />
    );
  }
  const tabs = visibleConfigTabs(viewer.isAdmin).map((tab) => ({
    path: tab,
    label: t(`np.config.tabs.${tab}`),
  }));
  return (
    <PageContainer>
      <PageHeader
        title={t('np.config.title')}
        description={
          viewer.isAdmin || viewer.isLoading
            ? t('np.config.description')
            : t('np.config.readOnlyDescription')
        }
      />
      <NpShortcuts />
      <NpRouteTabs
        label={t('np.config.tabsLabel')}
        tabs={tabs}
        keepSearch={false}
      />
      <Outlet />
    </PageContainer>
  );
}
