import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

import { NpRouteTabs } from '@/components/np-route-tabs';
import { NpShortcuts } from '@/components/np-shortcuts';
import { NpListSkeleton } from '@/components/np-states';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { useIsParentEntry } from '@/components/use-default-tab';

import { useConfigAccess } from './config-access.js';
import { visibleConfigTabs } from './config-model.js';

/**
 * Route `/config` (§G, "Settings"): the workspace settings in the front end instead of the system settings shell. Tabs
 * are child routes — General, Members, Process templates, Labels and GitHub — each shown when the viewer may read its
 * settings item (NP-117, `config-access.ts`); by default every member reads all but GitHub and owner/admin change
 * them. The bare URL redirects to the first readable tab once the checks are known.
 */
export default function ConfigPage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const isParentEntry = useIsParentEntry();
  const access = useConfigAccess();
  const visible = visibleConfigTabs(access.readable);
  if (isParentEntry) {
    return access.isPending ? (
      <PageContainer>
        <NpListSkeleton />
      </PageContainer>
    ) : (
      <Navigate
        replace
        to={{ pathname: visible[0] ?? 'general', search: location.search }}
      />
    );
  }
  const tabs = visible.map((tab) => ({
    path: tab,
    label: t(`np.config.tabs.${tab}`),
  }));
  return (
    <PageContainer>
      <PageHeader
        title={t('np.config.title')}
        description={
          access.editsAny || access.isPending
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
