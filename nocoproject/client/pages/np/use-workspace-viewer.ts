import { useApiClient } from '@nocobase/app-client';
import { useAuthorizationRevision } from '@nocobase/app-plugin-authorization/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { fetchMe } from './api.js';
import { npKeys } from './constants.js';
import { type Viewer, viewerFrom } from './permissions.js';

export interface WorkspaceViewer {
  /** The signed-in user and their business scopes; null while loading. */
  readonly viewer: Viewer | null;
  readonly isLoading: boolean;
}

/**
 * Refetches `GET /np/me` (the viewer's business scopes) and the member list whenever the built-in authorization
 * reports new permissions (`authorization:permissions-changed` bumps its revision), so buttons follow a role change
 * without a reload, like the menu does.
 */
export function useRefreshOnPermissionChange(): void {
  const queryClient = useQueryClient();
  const revision = useAuthorizationRevision();
  const seenRef = useRef(revision);
  useEffect(() => {
    if (seenRef.current === revision) return;
    seenRef.current = revision;
    void queryClient.invalidateQueries({ queryKey: npKeys.me });
    void queryClient.invalidateQueries({ queryKey: npKeys.members });
  }, [queryClient, revision]);
}

/**
 * Who is looking at a page: the viewer's business scopes as the server resolved them (NP-153, `permissions.ts`).
 * Everything here only hides or disables controls; the server refuses the same writes on its own.
 */
export function useWorkspaceViewer(): WorkspaceViewer {
  const api = useApiClient();
  useRefreshOnPermissionChange();
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  return { viewer: viewerFrom(me.data), isLoading: me.isPending };
}
