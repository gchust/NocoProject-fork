/**
 * NP-153 stage 2: the NocoProject page grants live in the business roles, and a newcomer gets `np-member` on their
 * first NocoProject request. The landing page makes that request (`GET /np/me`) when the viewer may not open the
 * inbox, then reads the permissions again; a viewer who may is forwarded without it.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import HomePage from '../../client/pages/home.js';
import { answer, renderNpRoutes } from './np-harness.js';
import { Route } from 'react-router';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const authz = vi.hoisted(() => ({ can: false, invalidate: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));
vi.mock('@nocobase/app-plugin-authorization/client', () => ({
  useCan: () => ({
    can: authz.can,
    isPending: false,
    error: null,
    retry: async () => undefined,
  }),
  useAuthorizationClient: () => ({ invalidate: authz.invalidate }),
}));

afterEach(() => {
  api.request.mockReset();
  authz.invalidate.mockReset();
  authz.can = false;
});

function routes() {
  return (
    <>
      <Route path='/' element={<HomePage />} />
      <Route path='/inbox' element={<p>Inbox page</p>} />
    </>
  );
}

describe('landing page (NP-153)', () => {
  it('enters NocoProject once and reads the permissions again', async () => {
    api.request.mockImplementation(
      answer({ 'GET np/me': { data: { userId: 'u1', name: 'New' } } }),
    );
    await renderNpRoutes(routes());
    await waitFor(() => expect(authz.invalidate).toHaveBeenCalledTimes(1));
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledWith({ path: 'np/me' });
    expect(screen.queryByText('Inbox page')).toBeNull();
  });

  it('forwards a viewer who may open the inbox without asking', async () => {
    authz.can = true;
    await renderNpRoutes(routes());
    expect(await screen.findByText('Inbox page')).toBeTruthy();
    expect(api.request).not.toHaveBeenCalled();
    expect(authz.invalidate).not.toHaveBeenCalled();
  });
});
