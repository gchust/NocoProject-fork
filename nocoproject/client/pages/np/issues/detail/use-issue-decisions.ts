import { useApiClient } from '@nocobase/app-client';
import { useQuery } from '@tanstack/react-query';

import { fetchInbox } from '../../api-inbox.js';
import { npKeys } from '../../constants.js';
import type { InboxItem } from '../../types.js';

/** The viewer's open decisions on one issue (`GET /np/inbox?kind=decision&resolved=false&issueId=`). */
export function useIssueDecisions(issueId: string): readonly InboxItem[] {
  const api = useApiClient();
  const query = useQuery({
    queryKey: npKeys.issueDecisions(issueId),
    queryFn: ({ signal }) =>
      fetchInbox(
        api,
        { kind: 'decision', archived: false, resolved: false, issueId },
        signal,
      ),
    retry: false,
  });
  return query.data?.items ?? [];
}
