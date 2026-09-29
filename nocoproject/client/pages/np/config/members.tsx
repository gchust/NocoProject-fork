import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';
import { Outlet, useSearchParams } from 'react-router';

import { NpTabBar } from '@/components/np-route-tabs';

import { MemberRolesPanel } from './member-roles-panel.js';
import { RolesPanel } from './roles-panel.js';

type MembersTab = 'members' | 'roles';

function readTab(value: string | null): MembersTab {
  return value === 'roles' ? 'roles' : 'members';
}

/**
 * Tab `/config/members` (iteration 1 §J 6, iteration 3 §G; NP-153): two sections in `?tab=` — Members (everyone who
 * signed in, with their business roles, and the pending invitations of NP-88) and Roles (the `np-` permission sets,
 * each opening as the covering page `/config/members/roles/:roleKey`). Business roles are assigned and defined here,
 * never in `/settings`: who may is the settings item `nocoproject.members` (`assign`, `define-roles`), checked again by
 * every endpoint.
 */
export default function MembersConfigTab(): ReactElement {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = readTab(params.get('tab'));

  function setTab(next: MembersTab): void {
    const search = new URLSearchParams(params);
    if (next === 'members') search.delete('tab');
    else search.set('tab', next);
    setParams(search, { replace: true });
  }

  return (
    <>
      <div className='space-y-6'>
        <NpTabBar
          idPrefix='np-members'
          label={t('np.roles.tabsLabel')}
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'members', label: t('np.roles.tabs.members') },
            { value: 'roles', label: t('np.roles.tabs.roles') },
          ]}
        />
        <div
          role='tabpanel'
          id={`np-members-panel-${tab}`}
          aria-labelledby={`np-members-tab-${tab}`}
        >
          {tab === 'members' ? <MemberRolesPanel /> : <RolesPanel />}
        </div>
      </div>
      <Outlet />
    </>
  );
}
