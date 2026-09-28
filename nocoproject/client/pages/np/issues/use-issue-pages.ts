import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { useState } from 'react';

import { toast } from '@/components/ui/toast';

import {
  fetchBoardColumn,
  fetchBoardV3,
  fetchIssuePage,
  mergeColumnPages,
} from '../api-iter3.js';
import { npKeys } from '../constants.js';
import type { BoardGroup, IssueFilters, IssueListItem } from '../types.js';
import type { IssueListPage } from '../types-iter3.js';

/**
 * The issue list as cursor pages (§D): `GET /np/issues?cursor=` 50 at a time, newest activity first. The key sits
 * under `npKeys.issues`, so the `np:issues` invalidation refetches every loaded page in order. A server without
 * cursors answers one bare list, which reads as a single last page.
 */
export function useIssuePages(filters: IssueFilters, enabled: boolean) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: npKeys.issuePages(filters),
    queryFn: ({ pageParam, signal }) =>
      fetchIssuePage(api, filters, { cursor: pageParam, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IssueListPage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export interface ColumnMore {
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
}

interface ColumnExtra {
  readonly issues: readonly IssueListItem[];
  readonly nextCursor: string | null;
}

/**
 * The board with "load more" per column (§D): the board request brings the first `columnLimit` cards of every column
 * with `hasMore` / `nextCursor`; a column's button fetches its next page and appends it. Extra pages are dropped when
 * the filters change. A card that also appears in a column's first page (it moved or was refreshed) is shown once,
 * where the fresh first page puts it.
 */
export function useBoardPages(filters: IssueFilters, enabled: boolean) {
  const { t } = useTranslation();
  const api = useApiClient();
  const board = useQuery({
    queryKey: npKeys.boardV3(filters),
    queryFn: ({ signal }) => fetchBoardV3(api, filters, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
  const filtersKey = JSON.stringify(filters);
  const [extras, setExtras] = useState<{
    readonly key: string;
    readonly columns: Readonly<Record<string, ColumnExtra>>;
  }>({ key: filtersKey, columns: {} });
  const [loading, setLoading] = useState<string | null>(null);
  const columns = extras.key === filtersKey ? extras.columns : {};

  async function loadMore(statusKey: string, cursor: string): Promise<void> {
    setLoading(statusKey);
    try {
      const page = await fetchBoardColumn(api, filters, statusKey, cursor);
      setExtras((current) => {
        const base = current.key === filtersKey ? current.columns : {};
        const previous = base[statusKey];
        return {
          key: filtersKey,
          columns: {
            ...base,
            [statusKey]: {
              issues: [...(previous?.issues ?? []), ...page.data],
              nextCursor: page.nextCursor,
            },
          },
        };
      });
    } catch {
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      });
    } finally {
      setLoading(null);
    }
  }

  const firstIds = new Set(
    (board.data ?? []).flatMap((group) =>
      group.issues.map((issue) => issue.id),
    ),
  );
  const groups: BoardGroup[] | undefined = board.data?.map((group) => {
    const extra = columns[group.statusKey];
    return {
      statusKey: group.statusKey,
      issues: extra
        ? mergeColumnPages(
            group.issues,
            [{ data: extra.issues, nextCursor: null }].map((page) => ({
              ...page,
              data: page.data.filter((issue) => !firstIds.has(issue.id)),
            })),
          )
        : group.issues,
    };
  });
  const more: Record<string, ColumnMore> = {};
  for (const group of board.data ?? []) {
    const extra = columns[group.statusKey];
    const cursor = extra ? extra.nextCursor : group.nextCursor;
    more[group.statusKey] = {
      hasMore: extra ? extra.nextCursor !== null : group.hasMore,
      loading: loading === group.statusKey,
      onLoadMore: () => {
        if (cursor) void loadMore(group.statusKey, cursor);
      },
    };
  }
  return { query: board, groups, more };
}
