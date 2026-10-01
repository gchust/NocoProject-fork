import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewIssuePage from '../../client/pages/np/issues/new.js';
import { answer, type RequestOptions, renderNpRoutes } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const fileRepository = vi.hoisted(() => ({ uploadOne: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => ({ repository: () => fileRepository }),
}));

const BATCH = {
  id: 'b1',
  projectId: 'p1',
  projectName: 'Website',
  source: 'paste',
  parser: 'heuristic',
  status: 'draft',
  createdAt: new Date().toISOString(),
};

const COMMON = {
  'GET np/projects': { data: [{ id: 'p1', name: 'Website' }] },
  'GET np/agents': { data: [] },
  'GET np/members': {
    data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'owner' }],
  },
  'GET np/labels': { data: [] },
  'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
};

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  api.request.mockReset();
  vi.unstubAllGlobals();
});

async function renderNewIssue(url: string) {
  await renderNpRoutes(
    <Route
      path='/issues'
      element={
        <>
          <p>Issue list</p>
          <Outlet />
        </>
      }
    >
      <Route path='new' element={<NewIssuePage />} />
    </Route>,
    { url },
  );
}

async function expectAsked() {
  expect(
    await screen.findByRole('alertdialog', {
      name: 'Discard unsaved changes?',
    }),
  ).toBeVisible();
}

describe('new issue dialog with unsaved input (NP-200)', () => {
  it('asks before discarding a typed description, and discards on request', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(answer(COMMON));
    await renderNewIssue('/issues/new?tab=ai');
    await user.type(
      await screen.findByRole('textbox', { name: 'Requirements' }),
      'Add a login page',
    );
    await user.keyboard('{Escape}');
    await expectAsked();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Issue list')).toBeInTheDocument();
  });

  it('asks for a filled-in manual form and closes an untouched one directly', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({ ...COMMON, 'GET np/settings': { data: {} } }),
    );
    await renderNewIssue('/issues/new?tab=manual');
    await user.type(
      await screen.findByRole('textbox', { name: 'Title' }),
      'Fix login',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await expectAsked();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Fix login',
    );
    await user.clear(screen.getByRole('textbox', { name: 'Title' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks for edited drafts until they are saved', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/intake/batches/b1': {
          data: {
            batch: BATCH,
            drafts: [
              { position: 1, parentPosition: null, fields: { title: 'Login' } },
            ],
          },
        },
        'PUT np/intake/batches/b1/drafts': (options: RequestOptions) => ({
          data: { drafts: (options.json as { drafts: unknown[] }).drafts },
        }),
      }),
    );
    await renderNewIssue('/issues/new?batch=b1');
    await user.type(
      await screen.findByRole('textbox', { name: 'Row 1 Title' }),
      ' form',
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await expectAsked();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Save drafts' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'np/intake/batches/b1/drafts' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('closes an untouched form opened with a preset project without asking', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({ ...COMMON, 'GET np/settings': { data: {} } }),
    );
    await renderNewIssue('/issues/new?tab=manual&project=p1');
    await screen.findByRole('textbox', { name: 'Title' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('drops the question when drafting finishes while it is asked', async () => {
    const user = userEvent.setup();
    let finish: (value: unknown) => void = () => {};
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'POST np/intake/batches': () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }),
    );
    await renderNewIssue('/issues/new?tab=ai');
    await user.type(
      await screen.findByRole('textbox', { name: 'Requirements' }),
      'Add a login page',
    );
    await user.click(screen.getByRole('button', { name: 'Draft issues' }));
    await user.keyboard('{Escape}');
    await expectAsked();
    await act(async () =>
      finish({
        data: {
          batch: BATCH,
          parser: 'heuristic',
          drafts: [
            { position: 1, parentPosition: null, fields: { title: 'Login' } },
          ],
        },
      }),
    );
    // The drafts are stored now: the question goes away and the table shows.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      await screen.findByRole('textbox', { name: 'Row 1 Title' }),
    ).toHaveValue('Login');
  });
});
