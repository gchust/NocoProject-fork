import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { NpListSkeleton, NpLoadError } from '@/components/np-states';

import { fetchMe } from '../api.js';
import { npKeys } from '../constants.js';
import { IssuesView } from '../issues/issues-view.js';
import { canEditIssue, viewerFrom } from '../permissions.js';
import { myIssueFilters, type MyIssuesRole } from './my-issues-model.js';
import { NewIssueButtonAbsolute } from './new-issue-link.js';

/**
 * One tab of `/my-issues`: the shared issue view with the viewer fixed as owner or executor. The filter for that role
 * is hidden from the toolbar (it cannot be changed here); the others stay in the query string.
 */
export function MyIssuesTab({
  role,
}: {
  readonly role: MyIssuesRole;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  if (me.isError && !me.data) {
    return (
      <NpLoadError
        title={t('np.issues.loadFailed')}
        error={me.error}
        onRetry={() => void me.refetch()}
      />
    );
  }
  if (!me.data) return <NpListSkeleton />;
  const { fixedFilters, hiddenFilters } = myIssueFilters(role, me.data.userId);
  const canEdit = canEditIssue(viewerFrom(me.data));
  return (
    <IssuesView
      fixedFilters={fixedFilters}
      hiddenFilters={hiddenFilters}
      detailBase='/issues'
      viewKey='my-issues'
      emptyTitle={t(`np.myIssues.empty.${role}`)}
      emptyDescription={t('np.myIssues.emptyDescription')}
      emptyAction={
        <NewIssueButtonAbsolute variant='outline' canEdit={canEdit} />
      }
    />
  );
}
