import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, FolderKanbanIcon, PlusIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';

import { DataTable } from '@/components/data-table';
import { NpShortcuts } from '@/components/np-shortcuts';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';

import { fetchProjectList } from '../api-projects.js';
import { npKeys } from '../constants.js';
import type { IssuesTopicPayload } from '../types.js';
import { useRealtimeTopic } from '../use-realtime.js';
import { useProjectColumns } from './columns.js';

/**
 * Route `/projects` (§J 4): every project the viewer can see, with status, lead, progress and membership. A private
 * project (visibility `members`) is filtered by the server for non-members. The page stays mounted under its `new`
 * dialog and `:projectId` covering page, and owns the `np:issues` subscription for both, since issue changes move
 * project progress and the project board.
 */
export default function ProjectsPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: ({ signal }) => fetchProjectList(api, signal),
  });
  const columns = useProjectColumns();

  useRealtimeTopic<IssuesTopicPayload>('np:issues', (payload) => {
    void queryClient.invalidateQueries({ queryKey: npKeys.projects });
    void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    if (payload?.issueId) {
      void queryClient.invalidateQueries({
        queryKey: npKeys.issue(payload.issueId),
      });
    }
  });

  let content: ReactElement;
  if (projects.isError && !projects.isFetching) {
    const forbidden =
      projects.error instanceof ApiClientError && projects.error.status === 403;
    content = (
      <Alert variant='destructive'>
        <AlertCircleIcon />
        <AlertTitle>{t('np.projects.loadFailed')}</AlertTitle>
        <AlertDescription>
          {forbidden ? t('np.common.forbidden') : t('np.common.requestFailed')}
        </AlertDescription>
        {forbidden ? null : (
          <AlertAction>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void projects.refetch()}
            >
              {t('status.retry')}
            </Button>
          </AlertAction>
        )}
      </Alert>
    );
  } else if (!projects.data) {
    content = (
      <div
        role='status'
        aria-label={t('status.loading')}
        className='space-y-2 rounded-lg border p-4'
      >
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-8 w-full' />
        ))}
      </div>
    );
  } else if (projects.data.length === 0) {
    content = (
      <Empty className='border'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <FolderKanbanIcon />
          </EmptyMedia>
          <EmptyTitle>{t('np.projects.emptyTitle')}</EmptyTitle>
          <EmptyDescription>
            {t('np.projects.emptyDescription')}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant='outline'
            nativeButton={false}
            render={<Link to='new' />}
          >
            <PlusIcon data-icon='inline-start' />
            {t('np.projects.new')}
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    content = (
      <DataTable
        columns={columns}
        data={projects.data}
        pageSize={20}
        showSelectedCount={false}
        getRowId={(project) => project.id}
        onRowClick={(row) => void navigate(encodeURIComponent(row.original.id))}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('np.projects.title')}
        description={t('np.projects.description')}
        actions={
          <Button nativeButton={false} render={<Link to='new' />}>
            <PlusIcon data-icon='inline-start' />
            {t('np.projects.new')}
          </Button>
        }
      />
      <NpShortcuts />
      {content}
      <Outlet />
    </PageContainer>
  );
}
