import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListTodoIcon } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { type To, useLocation, useNavigate } from 'react-router';

import { DataTable } from '@/components/data-table';
import { NP_VIRTUALIZE_TABLE_AFTER } from '@/components/np-scroll-parent';
import { NpEmpty, NpListSkeleton, NpLoadError } from '@/components/np-states';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

import { fetchLabels, fetchMembers, fetchWorkflows } from '../api-collab.js';
import { flattenIssuePages } from '../api-iter3.js';
import { fetchAgents, fetchProjects } from '../api.js';
import {
  DEFAULT_STATUS_CATALOG,
  KNOWN_STATUS_KEYS,
  catalogFromWorkflow,
  npKeys,
  statusLabelKey,
} from '../constants.js';
import { canEditIssue } from '../permissions.js';
import type {
  AgentsTopicPayload,
  IssueFilters,
  IssueListItem,
  IssuesTopicPayload,
} from '../types.js';
import { useRealtimeTopic } from '../use-realtime.js';
import { useWorkspaceViewer } from '../use-workspace-viewer.js';
import { IssueBoard } from './board/board.js';
import { useIssueColumns } from './columns.js';
import {
  type IssueFilterKey,
  hasIssueFilters,
  readIssueFilters,
  readStoredIssueView,
  resolveIssueView,
  storeIssueView,
  withIssueFilter,
  withIssueView,
  withoutIssueFilters,
} from './filters.js';
import { IssueToolbar, type IssueToolbarFilter } from './toolbar.js';
import { useBoardPages, useIssuePages } from './use-issue-pages.js';
import { useUrlSearch } from './use-url-search.js';

export interface IssuesViewProps {
  /** Filters the page always applies on top of the URL's (my issues: owner or executor = me). */
  readonly fixedFilters?: Partial<IssueFilters>;
  /** Toolbar filters the page does not offer, because `fixedFilters` sets them. */
  readonly hiddenFilters?: readonly IssueFilterKey[];
  /** Absolute detail links (`/issues/:id`) for a page that is not the issue list itself. */
  readonly detailBase?: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly emptyAction?: ReactNode;
  /** The page the list / board choice is remembered for (`issues`, `my-issues`). */
  readonly viewKey?: string;
}

/**
 * The issue list and board with their toolbar (§J 1, iteration 3 §D, §G), shared by `/issues` and `/my-issues`.
 * Search and filters live in the query string; the view is `?view=`, else the person's last choice on the page
 * (localStorage), else the board; the list loads cursor pages with "load more" and virtualizes past 200
 * rows, the board loads more per column. This component owns the `np:issues` subscription for the page and for the
 * issue detail covering it.
 */
export function IssuesView({
  fixedFilters,
  hiddenFilters = [],
  detailBase,
  emptyTitle,
  emptyDescription,
  emptyAction,
  viewKey = 'issues',
}: IssuesViewProps): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const {
    params,
    text,
    setText,
    scheduleSearch,
    updateParams,
    resetText,
    searchRef,
  } = useUrlSearch();

  const [stored, setStored] = useState(() => readStoredIssueView(viewKey));
  const view = resolveIssueView(params, stored);
  const urlFilters = readIssueFilters(params, KNOWN_STATUS_KEYS, view);
  const filters: IssueFilters = { ...urlFilters, ...fixedFilters };
  const list = useIssuePages(filters, view === 'list');
  const board = useBoardPages(filters, view === 'board');
  const { viewer } = useWorkspaceViewer();
  const canEdit = canEditIssue(viewer);

  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const labels = useQuery({
    queryKey: npKeys.labels,
    queryFn: () => fetchLabels(api),
  });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const workflows = useQuery({
    queryKey: npKeys.workflows,
    queryFn: () => fetchWorkflows(api),
    enabled: view === 'board',
  });

  useRealtimeTopic<IssuesTopicPayload>('np:issues', (payload) => {
    void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    void queryClient.invalidateQueries({
      queryKey: payload?.issueId
        ? npKeys.issue(payload.issueId)
        : ['np', 'issue'],
    });
  });
  useRealtimeTopic<AgentsTopicPayload>('np:agents', () => {
    void queryClient.invalidateQueries({ queryKey: npKeys.agents });
  });

  const issueLink = (issue: IssueListItem): To =>
    detailBase
      ? `${detailBase}/${encodeURIComponent(issue.id)}`
      : { pathname: encodeURIComponent(issue.id), search: location.search };
  const columns = useIssueColumns(detailBase);
  const filtered = hasIssueFilters(urlFilters);
  const hasFilters = filtered || text.trim() !== '';

  function clearFilters(): void {
    resetText();
    updateParams(withoutIssueFilters);
    searchRef.current?.focus();
  }

  // The filtered project's workflow when it names one, else the default workflow (§C).
  const project = projects.data?.find(
    (candidate) => candidate.id === filters.projectId,
  );
  const workflow =
    workflows.data?.find((candidate) => candidate.id === project?.workflowId) ??
    workflows.data?.find((candidate) => candidate.isDefault) ??
    workflows.data?.[0];
  const catalog = workflows.data
    ? catalogFromWorkflow(workflow)
    : DEFAULT_STATUS_CATALOG;

  const allFilters: IssueToolbarFilter[] = [
    ...(view === 'list'
      ? [
          {
            key: 'statusKey' as const,
            label: t('np.issues.statusFilterLabel'),
            allLabel: t('np.issues.allStatuses'),
            options: DEFAULT_STATUS_CATALOG.map((entry) => ({
              value: entry.key,
              label: t(statusLabelKey(entry.key)),
            })),
            value: urlFilters.statusKey,
          },
        ]
      : []),
    {
      key: 'projectId',
      label: t('np.filters.project'),
      allLabel: t('np.filters.allProjects'),
      options: (projects.data ?? []).map((item) => ({
        value: item.id,
        label: item.name,
      })),
      value: urlFilters.projectId,
    },
    {
      key: 'labelId',
      label: t('np.filters.label'),
      allLabel: t('np.filters.allLabels'),
      options: (labels.data ?? []).map((item) => ({
        value: item.id,
        label: item.name,
      })),
      value: urlFilters.labelId,
    },
    {
      key: 'ownerUserId',
      label: t('np.filters.owner'),
      allLabel: t('np.filters.anyOwner'),
      options: (members.data ?? []).map((item) => ({
        value: item.userId,
        label: item.name,
      })),
      value: urlFilters.ownerUserId,
    },
    {
      key: 'executorId',
      label: t('np.filters.executor'),
      allLabel: t('np.filters.anyExecutor'),
      options: [
        ...(agents.data ?? []).map((item) => ({
          value: item.id,
          label: item.name,
        })),
        ...(members.data ?? []).map((item) => ({
          value: item.userId,
          label: item.name,
        })),
      ],
      value: urlFilters.executorId,
    },
  ];
  const toolbarFilters = allFilters.filter(
    (filter) => !hiddenFilters.includes(filter.key),
  );

  const active = view === 'board' ? board.query : list;
  const rows = flattenIssuePages(list.data?.pages);

  let content: ReactElement;
  if (active.isError && !active.isFetching) {
    content = (
      <NpLoadError
        title={t('np.issues.loadFailed')}
        error={active.error}
        onRetry={() => {
          void active.refetch();
          searchRef.current?.focus();
        }}
      />
    );
  } else if (!active.data) {
    content = <NpListSkeleton />;
  } else if (view === 'board' && board.groups) {
    content = (
      <IssueBoard
        groups={board.groups}
        catalog={catalog}
        issueLink={detailBase ? issueLink : undefined}
        columnMore={board.more}
        fill
        canEdit={canEdit}
      />
    );
  } else if (rows.length === 0 && !filtered) {
    content = (
      <NpEmpty
        icon={<ListTodoIcon />}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  } else {
    content = (
      <div className='flex h-full min-h-0 flex-col gap-3'>
        <DataTable
          columns={columns}
          data={rows}
          fillHeight
          pagination={false}
          virtualizeAfter={NP_VIRTUALIZE_TABLE_AFTER}
          showSelectedCount={false}
          getRowId={(issue) => issue.id}
          onRowClick={(row) => void navigate(issueLink(row.original))}
          emptyMessage={
            <div className='flex flex-col items-center gap-2'>
              <span>{t('np.issues.noResults')}</span>
              <Button variant='outline' size='sm' onClick={clearFilters}>
                {t('np.common.clearFilters')}
              </Button>
            </div>
          }
        />
        {rows.length > 0 ? (
          <div className='flex shrink-0 items-center justify-between gap-3 text-sm text-muted-foreground'>
            <span className='tabular-nums'>
              {t('np.pagination.shown', { count: rows.length })}
            </span>
            {list.hasNextPage ? (
              <Button
                variant='outline'
                size='sm'
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? (
                  <Spinner data-icon='inline-start' />
                ) : null}
                {t('np.pagination.loadMore')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  // The view fills its page (nocosolution/guidelines/frontend-standard.md §3.6, §8): the toolbar on top, the board or the table below in a
  // bounded area that scrolls inside — board columns each on their own, the table body under a sticky header.
  return (
    <div className='flex h-full min-h-0 flex-col gap-4'>
      <IssueToolbar
        searchRef={searchRef}
        searchText={text}
        onSearchTextChange={setText}
        onSearchSettled={scheduleSearch}
        filters={toolbarFilters}
        view={view}
        hasFilters={hasFilters}
        fetching={active.isFetching && active.data !== undefined}
        onFilterChange={(key, value) =>
          updateParams((current) => withIssueFilter(current, key, value))
        }
        onViewChange={(next) => {
          storeIssueView(viewKey, next);
          setStored(next);
          updateParams((current) => withIssueView(current, next));
        }}
        onClear={clearFilters}
      />
      <div className='min-h-0 flex-1'>{content}</div>
    </div>
  );
}
