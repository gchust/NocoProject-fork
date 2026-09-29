import { act, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authzRevision } from './np-authz-double.js';
import { renderNp } from './np-harness.js';

import {
  canDeleteProject,
  canEditProject,
} from '../../client/pages/np/permissions.js';
import { ProjectActions } from '../../client/pages/np/projects/detail/project-actions.js';
import type { ProjectDetail } from '../../client/pages/np/types.js';
import { useWorkspaceViewer } from '../../client/pages/np/use-workspace-viewer.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const PROJECT = {
  id: 'p1',
  name: 'Apollo',
  leadUserId: 'u9',
} as unknown as ProjectDetail;

/** The project page's wiring: the viewer's scopes from `GET /np/me`, the rules of `permissions.ts`. */
function ProjectControls(): ReactElement {
  const { viewer } = useWorkspaceViewer();
  return (
    <>
      <span>{canEditProject(viewer, PROJECT) ? 'editable' : 'read-only'}</span>
      <ProjectActions project={PROJECT} canDelete={canDeleteProject(viewer)} />
    </>
  );
}

function meWith(scopes: Record<string, string>): void {
  api.request.mockImplementation((options: { path: string }) =>
    Promise.resolve(
      options.path === 'np/me'
        ? { data: { userId: 'u1', name: 'Zhou', scopes } }
        : { data: [] },
    ),
  );
}

afterEach(() => api.request.mockReset());

describe('buttons follow the business scopes (NP-153)', () => {
  it('reads the scopes from the server instead of the member role', async () => {
    meWith({
      'nocoproject.projects/manage': 'all',
      'nocoproject.projects/delete': 'all',
    });
    await renderNp(<ProjectControls />);
    expect(await screen.findByText('editable')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'More project actions' }),
    ).toBeVisible();
  });

  it('keeps "related" to the project lead and hides delete without "all"', async () => {
    meWith({
      'nocoproject.projects/manage': 'related',
      'nocoproject.projects/delete': 'none',
    });
    await renderNp(<ProjectControls />);
    expect(await screen.findByText('read-only')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'More project actions' }),
    ).toBeNull();
  });

  it('refetches the scopes when the permissions change', async () => {
    meWith({ 'nocoproject.projects/delete': 'none' });
    await renderNp(<ProjectControls />);
    await screen.findByText('read-only');
    expect(
      screen.queryByRole('button', { name: 'More project actions' }),
    ).toBeNull();

    meWith({ 'nocoproject.projects/delete': 'all' });
    act(() => authzRevision.bump());
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'More project actions' }),
      ).toBeVisible(),
    );
  });
});
