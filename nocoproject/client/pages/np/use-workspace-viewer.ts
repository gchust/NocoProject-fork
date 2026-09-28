import { useApiClient } from '@nocobase/app-client';
import { useQuery } from '@tanstack/react-query';

import { fetchMembers } from './api-collab.js';
import { fetchMe } from './api.js';
import { npKeys } from './constants.js';
import { isWorkspaceAdmin, type Viewer, viewerFrom } from './permissions.js';

export interface WorkspaceViewer {
  readonly viewer: Viewer | null;
  /** owner/admin: may edit settings, labels and the GitHub connection (§G). */
  readonly isAdmin: boolean;
  readonly isLoading: boolean;
}

/**
 * Who is looking at a settings or knowledge page: the viewer's workspace role from the member list. Everything here only hides or
 * disables controls; the server refuses the same writes on its own.
 */
export function useWorkspaceViewer(): WorkspaceViewer {
  const api = useApiClient();
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const viewer = viewerFrom(me.data?.userId, members.data);
  return {
    viewer,
    isAdmin: isWorkspaceAdmin(viewer),
    isLoading: me.isPending || members.isPending,
  };
}
