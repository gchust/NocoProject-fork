import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircleIcon,
  CalendarIcon,
  ListIcon,
  LockIcon,
  PlusIcon,
  WorkflowIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { Link, Outlet, useParams, useSearchParams } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { RouteChildPage } from '@/components/route-child-page';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpProgressRing } from '@/components/np-live';
import { NpTabBar } from '@/components/np-route-tabs';
import { NpDetailSkeleton } from '@/components/np-states';
import { Skeleton } from '@/components/ui/skeleton';

import { fetchMembers } from '../../api-collab.js';
import { fetchProject } from '../../api-projects.js';
import { fetchMe } from '../../api.js';
import { catalogFromWorkflow, npKeys } from '../../constants.js';
import { useNpFormatters } from '../../format.js';
import { type BoardColumnMore, IssueBoard } from '../../issues/board/board.js';
import { useBoardPages } from '../../issues/use-issue-pages.js';
import {
  canDeleteProject,
  canEditProject,
  viewerFrom,
} from '../../permissions.js';
import type { BoardGroup, Member, ProjectDetail } from '../../types.js';
import { ProjectStatusBadge } from '../project-badges.js';
import { progressFromCounts, progressFromGroups } from '../progress.js';
import { ProjectKnowledge } from './knowledge-tab.js';
import { ProjectOverview } from './overview.js';
import { ProjectActions } from './project-actions.js';

/**
 * Route `/projects/:projectId` (§J 4, client/pages/np/README.md §3): a covering child page over the project list.
 * The header carries the progress ring, name, status, lead, dates and workflow; three tabs (`?tab=`, because the
 * page's child routes are its dialogs) hold Overview (numbers, status distribution, description, properties,
 * repositories, members), Issues (the board, columns in workflow order, drag to change status) and Knowledge (documents
 * and pending agent proposals). "New issue" opens the issues page's dialog with the project preselected (one issue or
 * many, iteration 4 §D; the old `intake` child redirects there). The `resources/new` dialog renders in the outlet
 * beside the layer.
 */
export default function ProjectDetailPage(): ReactElement {
  const { projectId = '' } = useParams();
  return (
    <>
      <RouteChildPage>
        <ProjectDetailView key={projectId} projectId={projectId} />
      </RouteChildPage>
      <Outlet />
    </>
  );
}

function ProjectDetailView({
  projectId,
}: {
  readonly projectId: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const project = useQuery({
    queryKey: npKeys.project(projectId),
    queryFn: ({ signal }) => fetchProject(api, projectId, signal),
    retry: (count, error) =>
      !(error instanceof ApiClientError && [403, 404].includes(error.status)) &&
      count < 2,
  });
  const filters = { projectId };
  const board = useBoardPages(filters, true);
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });

  if (project.isError && !project.data) {
    const status =
      project.error instanceof ApiClientError
        ? project.error.status
        : undefined;
    return (
      <div className='space-y-4 px-6 py-6 md:px-8'>
        <Breadcrumbs />
        <Alert variant='destructive'>
          <AlertCircleIcon />
          <AlertTitle>{t('np.projects.detailLoadFailed')}</AlertTitle>
          <AlertDescription>
            {status === 404
              ? t('np.projects.notFound')
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
                {t('np.projects.backToList')}
              </Button>
            ) : (
              <Button
                variant='outline'
                size='sm'
                onClick={() => void project.refetch()}
              >
                {t('status.retry')}
              </Button>
            )}
          </AlertAction>
        </Alert>
      </div>
    );
  }

  if (!project.data) return <NpDetailSkeleton />;

  const viewer = viewerFrom(me.data?.userId, members.data);
  return (
    <ProjectLayout
      project={project.data}
      groups={board.groups}
      columnMore={board.more}
      workspaceMembers={members.data ?? []}
      canEdit={canEditProject(viewer, project.data)}
      canDelete={canDeleteProject(viewer)}
    />
  );
}

type ProjectTab = 'overview' | 'issues' | 'knowledge';

function readProjectTab(value: string | null): ProjectTab {
  return value === 'issues' || value === 'knowledge' ? value : 'overview';
}

function ProjectLayout({
  project,
  groups,
  columnMore,
  workspaceMembers,
  canEdit,
  canDelete,
}: {
  readonly project: ProjectDetail;
  readonly groups: readonly BoardGroup[] | undefined;
  readonly columnMore: Readonly<Record<string, BoardColumnMore>>;
  readonly workspaceMembers: readonly Member[];
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const [params, setParams] = useSearchParams();
  const tab = readProjectTab(params.get('tab'));
  const catalog = catalogFromWorkflow(project.workflow);
  const progress = project.issueCounts
    ? progressFromCounts(project.issueCounts)
    : progressFromGroups(groups ?? [], catalog);
  const total = project.issueCounts?.total;

  function setTab(next: ProjectTab): void {
    const search = new URLSearchParams(params);
    if (next === 'overview') search.delete('tab');
    else search.set('tab', next);
    setParams(search, { replace: true });
  }

  const meta: ReactElement[] = [];
  meta.push(
    <span key='lead' className='inline-flex items-center gap-1.5'>
      {t('np.projects.columns.lead')}
      {project.leadName ? (
        <NpActorAvatar
          type='user'
          name={project.leadName}
          size='xs'
          showName
          className='text-foreground'
        />
      ) : (
        <span>
          —<span className='sr-only'>{t('np.projects.noLead')}</span>
        </span>
      )}
    </span>,
  );
  if (project.startDate || project.dueDate) {
    meta.push(
      <span key='dates' className='inline-flex items-center gap-1.5'>
        <CalendarIcon className='size-3.5' aria-hidden='true' />
        {format.date(project.startDate)} → {format.date(project.dueDate)}
      </span>,
    );
  }
  if (project.workflow?.name) {
    meta.push(
      <span key='workflow' className='inline-flex items-center gap-1.5'>
        <WorkflowIcon className='size-3.5' aria-hidden='true' />
        {project.workflow.name}
      </span>,
    );
  }
  meta.push(
    <span key='progress' className='tabular-nums'>
      {t('np.projects.progressLabel', {
        done: progress.done,
        total: progress.total,
      })}
    </span>,
  );

  return (
    <div className='w-full space-y-6 px-6 py-6 md:px-8'>
      <div className='space-y-4'>
        <Breadcrumbs />
        <header className='flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between'>
          <div className='flex min-w-0 items-start gap-4'>
            <NpProgressRing
              percent={progress.percent}
              size={48}
              label={t('np.projects.progressLabel', {
                done: progress.done,
                total: progress.total,
              })}
            />
            <div className='min-w-0 space-y-1.5'>
              <h1 className='flex min-w-0 items-center gap-2 font-heading text-2xl font-semibold tracking-tight'>
                <span className='truncate'>{project.name}</span>
                {project.visibility === 'members' ? (
                  <LockIcon
                    className='size-4 shrink-0 text-muted-foreground'
                    aria-label={t('np.projects.visibility.members')}
                  />
                ) : null}
                <ProjectStatusBadge status={project.status} />
              </h1>
              <p className='flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground'>
                {meta}
              </p>
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <Button
              nativeButton={false}
              render={
                <Link
                  to={{
                    pathname: '/issues/new',
                    search: `?project=${encodeURIComponent(project.id)}`,
                  }}
                />
              }
            >
              <PlusIcon data-icon='inline-start' />
              {t('np.issues.new')}
            </Button>
            <ProjectActions project={project} canDelete={canDelete} />
          </div>
        </header>
      </div>
      <NpTabBar
        idPrefix='np-project'
        label={t('np.projectPage.tabs.label')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: t('np.projectPage.tabs.overview') },
          {
            value: 'issues',
            label: t('np.projectPage.tabs.issues'),
            count: total,
          },
          { value: 'knowledge', label: t('np.projectPage.tabs.knowledge') },
        ]}
      />
      <div
        role='tabpanel'
        id={`np-project-panel-${tab}`}
        aria-labelledby={`np-project-tab-${tab}`}
      >
        {tab === 'overview' ? (
          <ProjectOverview
            project={project}
            catalog={catalog}
            workspaceMembers={workspaceMembers}
            canEdit={canEdit}
          />
        ) : tab === 'issues' ? (
          <div className='space-y-3'>
            <div className='flex justify-end'>
              <Button
                variant='ghost'
                size='sm'
                nativeButton={false}
                render={
                  <Link
                    to={{
                      pathname: '/issues',
                      search: `?project=${encodeURIComponent(project.id)}`,
                    }}
                  />
                }
              >
                <ListIcon data-icon='inline-start' />
                {t('np.projectPage.openInList')}
              </Button>
            </div>
            {groups ? (
              <IssueBoard
                groups={groups}
                columnMore={columnMore}
                catalog={catalog}
                issueLink={(issue) => `/issues/${encodeURIComponent(issue.id)}`}
              />
            ) : (
              <div
                role='status'
                aria-label={t('status.loading')}
                className='flex gap-3'
              >
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton
                    key={index}
                    className='h-64 w-[18rem] shrink-0 rounded-xl'
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <ProjectKnowledge projectId={project.id} />
        )}
      </div>
    </div>
  );
}
