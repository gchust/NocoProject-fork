import { useApiClient } from '@nocobase/app-client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { fetchIssueActivities } from '../../api-iter3.js';
import { npKeys } from '../../constants.js';
import type { IssueActivity } from '../../types.js';
import type { ActivityPage } from '../../types-iter3.js';

/**
 * Older activities of an issue on demand (§D): the detail brings the newest 50 and `activitiesNextCursor`; "load
 * older" pages `GET /np/issues/:id/activities?cursor=` from there. The query sits under `npKeys.issue(id)`, so the
 * realtime invalidation of the issue refetches the loaded pages too. Nothing is requested until asked.
 */
export function useOlderActivities(
  issueId: string,
  firstCursor: string | null | undefined,
) {
  const api = useApiClient();
  const [requested, setRequested] = useState(false);
  const query = useInfiniteQuery({
    queryKey: npKeys.issueActivities(issueId, firstCursor ?? null),
    queryFn: ({ pageParam, signal }) =>
      fetchIssueActivities(api, issueId, pageParam, signal),
    initialPageParam: firstCursor ?? '',
    getNextPageParam: (last: ActivityPage) => last.nextCursor ?? undefined,
    enabled: requested && !!firstCursor,
  });
  const activities: IssueActivity[] =
    query.data?.pages.flatMap((page) => page.data) ?? [];
  const hasMore = !!firstCursor && (!query.data || query.hasNextPage);
  return {
    activities,
    hasMore,
    loading: query.isFetching,
    loadMore: () => {
      if (!requested) setRequested(true);
      else void query.fetchNextPage();
    },
  };
}
