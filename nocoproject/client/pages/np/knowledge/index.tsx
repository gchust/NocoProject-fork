import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { BookOpenTextIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';

import { DataTable } from '@/components/data-table';
import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpShortcuts } from '@/components/np-shortcuts';
import { NpEmpty, NpListSkeleton, NpLoadError } from '@/components/np-states';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';

import {
  fetchKnowledgeList,
  fetchKnowledgeProposals,
} from '../api-knowledge.js';
import { fetchProjects } from '../api.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import { useUrlSearch } from '../issues/use-url-search.js';
import type { KnowledgeDocSummary } from '../types-iter3.js';
import { useWorkspaceViewer } from '../use-workspace-viewer.js';
import {
  filterKnowledge,
  readKnowledgeScope,
  writableProjects,
} from './knowledge-model.js';
import { KnowledgePendingProposals } from './pending-proposals.js';

/**
 * Route `/knowledge` (§B, "Knowledge"): the Markdown documents agents read before they work — per project, or for the
 * whole workspace. Filter by project (`?project=`, `workspace` for workspace documents) and search (`?q=`); proposals
 * agents made that the viewer decides are listed on top with accept / reject. A document opens as a covering page,
 * "New document" as a dialog.
 */
export default function KnowledgePage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const format = useNpFormatters();
  const { params, text, setText, scheduleSearch, updateParams, searchRef } =
    useUrlSearch();
  const scope = readKnowledgeScope(params.get('project'));
  const q = params.get('q')?.trim() || undefined;
  const filters = {
    projectId:
      scope.kind === 'project'
        ? scope.projectId
        : scope.kind === 'workspace'
          ? 'none'
          : undefined,
    q,
  };
  const docs = useQuery({
    queryKey: npKeys.knowledgeList(filters),
    queryFn: ({ signal }) => fetchKnowledgeList(api, filters, signal),
    placeholderData: keepPreviousData,
  });
  const proposals = useQuery({
    queryKey: npKeys.knowledgeProposals,
    queryFn: ({ signal }) => fetchKnowledgeProposals(api, 'pending', signal),
  });
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const { viewer, isAdmin } = useWorkspaceViewer();
  const canCreate =
    isAdmin || writableProjects(viewer, projects.data).length > 0;
  const columns = useMemo<ColumnDef<KnowledgeDocSummary, unknown>[]>(() => {
    const projectName = (projectId: string | null): string =>
      projectId
        ? (projects.data?.find((project) => project.id === projectId)?.name ??
          projectId)
        : t('np.knowledge.workspace');
    return [
      {
        accessorKey: 'title',
        header: t('np.knowledge.columns.title'),
        cell: ({ row }) => (
          <div className='min-w-56 space-y-0.5'>
            <Link
              to={{
                pathname: encodeURIComponent(row.original.id),
                search: location.search,
              }}
              onClick={(event) => event.stopPropagation()}
              className='font-medium hover:underline'
            >
              {row.original.title}
            </Link>
            {row.original.archivedAt ? (
              <NpTag tone='slate' className='ml-2'>
                {t('np.knowledge.archived')}
              </NpTag>
            ) : null}
            {row.original.summary ? (
              <p className='line-clamp-1 text-xs text-muted-foreground'>
                {row.original.summary}
              </p>
            ) : null}
            {row.original.matchExcerpt ? (
              <p className='line-clamp-1 text-xs text-muted-foreground italic'>
                “{row.original.matchExcerpt}”
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'project',
        header: t('np.knowledge.columns.project'),
        cell: ({ row }) => (
          <span className='text-sm'>
            {row.original.projectName ?? projectName(row.original.projectId)}
          </span>
        ),
      },
      {
        accessorKey: 'slug',
        header: t('np.knowledge.columns.slug'),
        cell: ({ row }) => (
          <span className='font-mono text-xs text-muted-foreground'>
            {row.original.slug}
          </span>
        ),
      },
      {
        accessorKey: 'version',
        header: t('np.knowledge.columns.version'),
        cell: ({ row }) => (
          <span className='font-mono text-xs'>v{row.original.version}</span>
        ),
      },
      {
        accessorKey: 'updatedAt',
        header: t('np.knowledge.columns.updated'),
        cell: ({ row }) => (
          <span className='inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-muted-foreground'>
            {row.original.updatedByName ? (
              <NpActorAvatar
                type={row.original.updatedByType ?? 'user'}
                name={row.original.updatedByName}
                size='xs'
              />
            ) : null}
            <span title={format.dateTime(row.original.updatedAt)}>
              {format.relative(row.original.updatedAt)}
            </span>
          </span>
        ),
      },
    ];
  }, [t, format, location.search, projects.data]);

  const rows = docs.data ? filterKnowledge(docs.data, scope) : undefined;
  let content: ReactElement;
  if (docs.isError && !docs.data) {
    content = (
      <NpLoadError
        title={t('np.knowledge.loadFailed')}
        error={docs.error}
        onRetry={() => void docs.refetch()}
      />
    );
  } else if (!rows) {
    content = <NpListSkeleton />;
  } else if (rows.length === 0 && !q && scope.kind === 'all') {
    content = (
      <NpEmpty
        icon={<BookOpenTextIcon />}
        title={t('np.knowledge.emptyTitle')}
        description={t('np.knowledge.emptyDescription')}
        action={
          canCreate ? (
            <Button
              variant='outline'
              nativeButton={false}
              render={
                <Link to={{ pathname: 'new', search: location.search }} />
              }
            >
              <PlusIcon data-icon='inline-start' />
              {t('np.knowledge.new')}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    content = (
      <DataTable
        columns={columns}
        data={rows}
        pageSize={20}
        showSelectedCount={false}
        getRowId={(doc) => doc.id}
        emptyMessage={t('np.knowledge.noResults')}
        onRowClick={(row) =>
          void navigate({
            pathname: encodeURIComponent(row.original.id),
            search: location.search,
          })
        }
      />
    );
  }

  const pending = proposals.data ?? [];
  return (
    <PageContainer>
      <PageHeader
        title={t('np.knowledge.title')}
        description={t('np.knowledge.description')}
        actions={
          canCreate ? (
            <Button
              nativeButton={false}
              render={
                <Link to={{ pathname: 'new', search: location.search }} />
              }
            >
              <PlusIcon data-icon='inline-start' />
              {t('np.knowledge.new')}
            </Button>
          ) : undefined
        }
      />
      <NpShortcuts />
      <KnowledgePendingProposals proposals={pending} />
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <InputGroup className='w-full sm:w-64'>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              value={text}
              placeholder={t('np.knowledge.searchPlaceholder')}
              aria-label={t('np.knowledge.searchLabel')}
              onChange={(event) => {
                setText(event.target.value);
                if (!(event.nativeEvent as InputEvent).isComposing) {
                  scheduleSearch(event.target.value);
                }
              }}
              onCompositionEnd={(event) =>
                scheduleSearch(event.currentTarget.value)
              }
            />
          </InputGroup>
          <PropertySelect
            id='np-knowledge-project'
            size='default'
            className='w-48'
            aria-label={t('np.filters.project')}
            options={[
              { value: 'workspace', label: t('np.knowledge.workspaceOnly') },
              ...(projects.data ?? []).map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
            value={params.get('project')}
            noneLabel={t('np.filters.allProjects')}
            onChange={(value) =>
              updateParams((current) => {
                const next = new URLSearchParams(current);
                if (value) next.set('project', value);
                else next.delete('project');
                return next;
              })
            }
          />
          {docs.isFetching && docs.data ? (
            <Spinner
              className='size-4 text-muted-foreground'
              aria-label={t('status.loading')}
            />
          ) : null}
        </div>
        {content}
      </div>
      <Outlet />
    </PageContainer>
  );
}
