import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

import { NpRouteTabs } from '@/components/np-route-tabs';
import { NpShortcuts } from '@/components/np-shortcuts';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { useIsParentEntry } from '@/components/use-default-tab';

/**
 * Route `/reports` (§G, "报表"): the acceptance metrics (§C) and run usage (iteration 2 §I) as tabs that are child
 * routes. The bare URL redirects to `metrics`, keeping the query string (both tabs read `from` / `to`).
 */
export default function ReportsPage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const isParentEntry = useIsParentEntry();
  if (isParentEntry) {
    return (
      <Navigate replace to={{ pathname: 'metrics', search: location.search }} />
    );
  }
  return (
    <PageContainer>
      <PageHeader
        title={t('np.reports.title')}
        description={t('np.reports.description')}
      />
      <NpShortcuts />
      <NpRouteTabs
        label={t('np.reports.tabsLabel')}
        tabs={[
          { path: 'metrics', label: t('np.reports.tabs.metrics') },
          { path: 'usage', label: t('np.reports.tabs.usage') },
        ]}
      />
      <Outlet />
    </PageContainer>
  );
}
