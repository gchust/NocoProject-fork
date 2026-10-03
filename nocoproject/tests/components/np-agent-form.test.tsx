import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentForm } from '../../client/pages/np/agents/detail/agent-form.js';
import NewAgentPage from '../../client/pages/np/agents/new.js';
import type { AgentListItem } from '../../client/pages/np/types.js';
import {
  answer,
  type RequestOptions,
  renderNp,
  renderNpRoutes,
} from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);

const RUNTIME = {
  id: 'r1',
  name: 'dev',
  provider: 'opencode',
  kind: 'personal',
  status: 'online',
  lastSeenAt: null,
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
  vi.unstubAllGlobals();
});

describe('agent kind and reasoning effort (iteration 4 §C)', () => {
  it('creates a project manager with a reasoning effort', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'GET np/runtimes': { data: [RUNTIME] },
        'POST np/agents': (options: RequestOptions) => {
          posted.push(options.json);
          return { data: { id: 'pm', name: 'PM' } };
        },
      }),
    );
    await renderNp(<NewAgentPage />, {
      url: '/agents/new',
      path: '/agents/new',
    });
    // NP-219: the type comes first; the other fields appear once it is chosen.
    expect(
      screen.queryByRole('textbox', { name: 'Name' }),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole('radio', { name: /^Computer agent/ }),
    );
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'PM');
    await user.type(
      screen.getByRole('textbox', { name: 'Instructions' }),
      'Answer questions.',
    );
    await user.click(screen.getByRole('combobox', { name: 'Runtime' }));
    await user.click(await screen.findByRole('option', { name: /dev/ }));
    expect(
      screen.queryByRole('combobox', { name: 'Kind' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Reasoning effort' }),
    ).toHaveTextContent('Default');

    await user.click(
      screen.getByRole('combobox', { name: 'Reasoning effort' }),
    );
    await user.click(await screen.findByRole('option', { name: 'High' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(posted).toEqual([
        expect.objectContaining({
          name: 'PM',
          provider: 'opencode',
          capabilities: ['context.read', 'comment.create'],
          reasoningEffort: 'high',
          runtimeType: 'computer',
        }),
      ]),
    );
  });

  it('edits an agent’s kind and resets the effort to the default', async () => {
    const user = userEvent.setup();
    const patched: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'PATCH np/agents/pm': (options: RequestOptions) => {
          patched.push(options.json);
          return { data: { id: 'pm', name: 'PM' } };
        },
      }),
    );
    const agent: AgentListItem = {
      id: 'pm',
      name: 'PM',
      instructions: 'Answer questions.',
      runtimeId: 'r1',
      provider: 'opencode',
      kind: 'manager',
      capabilities: ['context.read', 'comment.create'],
      configurationRevision: 3,
      reasoningEffort: 'max',
    };
    await renderNp(
      <AgentForm
        agent={agent}
        runtimes={[RUNTIME as never]}
        agents={[agent]}
        members={[]}
        canEdit
      />,
    );
    expect(
      screen.queryByRole('combobox', { name: 'Kind' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Reasoning effort' }),
    ).toHaveTextContent('Max');
    await user.click(
      screen.getByRole('combobox', { name: 'Reasoning effort' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Default' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patched).toEqual([
        expect.objectContaining({
          configurationRevision: 3,
          // A project manager type agent always sends the fixed set (NP-183 §2.2).
          capabilities: expect.arrayContaining(['member.act', 'repo.read']),
          reasoningEffort: null,
        }),
      ]),
    );
  });
});

describe('closing the new agent dialog with unsaved input (NP-200)', () => {
  it('asks before discarding what was typed, and closes an untouched form directly', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({ 'GET np/runtimes': { data: [RUNTIME] } }),
    );
    await renderNpRoutes(
      <Route
        path='/agents'
        element={
          <>
            <span>Agent list</span>
            <Outlet />
          </>
        }
      >
        <Route path='new' element={<NewAgentPage />} />
      </Route>,
      // A type preselected by the link is where the form starts, not input.
      { url: '/agents/new?runtimeType=computer' },
    );
    const name = await screen.findByRole('textbox', { name: 'Name' });
    await user.type(name, 'PM');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByRole('alertdialog', {
        name: 'Discard unsaved changes?',
      }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('PM');

    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Agent list')).toBeInTheDocument();
  });

  it('treats a kind preselected by the link as the starting point, not as input', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({ 'GET np/runtimes': { data: [RUNTIME] } }),
    );
    await renderNpRoutes(
      <Route
        path='/agents'
        element={
          <>
            <span>Agent list</span>
            <Outlet />
          </>
        }
      >
        <Route path='new' element={<NewAgentPage />} />
      </Route>,
      { url: '/agents/new?kind=manager' },
    );
    await screen.findByRole('radio', { name: /^Computer agent/ });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Agent list')).toBeInTheDocument();
  });
});
