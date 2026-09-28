import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentForm } from '../../client/pages/np/agents/detail/agent-form.js';
import NewAgentPage from '../../client/pages/np/agents/new.js';
import type { AgentListItem } from '../../client/pages/np/types.js';
import { answer, type RequestOptions, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));
vi.mock('@/components/ui/toast', () => ({ toast }));

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
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'PM');
    await user.type(
      screen.getByRole('textbox', { name: 'Instructions' }),
      'Answer questions.',
    );
    await user.click(screen.getByRole('combobox', { name: 'Runtime' }));
    await user.click(await screen.findByRole('option', { name: /dev/ }));
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveTextContent(
      'Coding',
    );
    expect(
      screen.getByRole('combobox', { name: 'Reasoning effort' }),
    ).toHaveTextContent('Default');
    await user.click(screen.getByRole('combobox', { name: 'Kind' }));
    await user.click(
      await screen.findByRole('option', { name: 'Project manager' }),
    );
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
          kind: 'manager',
          reasoningEffort: 'high',
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
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveTextContent(
      'Project manager',
    );
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
        expect.objectContaining({ kind: 'manager', reasoningEffort: null }),
      ]),
    );
  });
});
