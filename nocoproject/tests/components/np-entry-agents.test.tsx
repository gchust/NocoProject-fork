import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiErrorMessage } from '../../client/pages/np/api-error.js';
import GeneralConfigTab from '../../client/pages/np/config/general.js';
import {
  entryAgentEligible,
  entryAgentProblem,
} from '../../client/pages/np/config/pm-settings-model.js';
import type { AgentListItem } from '../../client/pages/np/types.js';
import { authzDouble } from './np-authz-double.js';
import { answer, renderNp } from './np-harness.js';

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
vi.mock('../../client/pages/np/use-realtime.js', () => ({
  useRealtimeTopic: () => undefined,
}));

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

const agent = (over: Partial<AgentListItem>): AgentListItem => ({
  id: 'a',
  name: 'Agent',
  runtimeId: 'r1',
  provider: 'claude',
  kind: 'coder',
  canInvoke: true,
  capabilities: ['context.read', 'comment.create'],
  ...over,
});

const MANAGER = agent({ id: 'm1', name: 'Manager', kind: 'manager' });
const CODER = agent({ id: 'c1', name: 'Coder' });

describe('entry agent rules', () => {
  it('lists only live project managers for the conversation entry', () => {
    expect(entryAgentEligible('conversation', MANAGER)).toBe(true);
    expect(entryAgentEligible('conversation', CODER)).toBe(false);
    expect(
      entryAgentEligible('conversation', { ...MANAGER, archivedAt: 'x' }),
    ).toBe(false);
  });

  it('lists only non-managers that can comment for the completion entry', () => {
    expect(entryAgentEligible('completion', CODER)).toBe(true);
    expect(entryAgentEligible('completion', MANAGER)).toBe(false);
    expect(
      entryAgentEligible('completion', { ...CODER, capabilities: [] }),
    ).toBe(false);
    expect(
      entryAgentEligible('completion', { ...CODER, canInvoke: false }),
    ).toBe(false);
  });

  it('names why a saved agent no longer fits', () => {
    const list = [MANAGER, CODER];
    expect(entryAgentProblem('conversation', 'c1', list)).toBe('notManager');
    expect(entryAgentProblem('completion', 'm1', list)).toBe(
      'managerCompletion',
    );
    expect(entryAgentProblem('completion', 'gone', list)).toBe('unavailable');
    expect(entryAgentProblem('completion', 'c1', list)).toBeNull();
    expect(entryAgentProblem('completion', null, list)).toBeNull();
  });
});

describe('apiErrorMessage', () => {
  const t = (key: string) => key;
  const failure = (status: number, message: string, code?: string) =>
    new ApiClientError(message, {
      status,
      code,
      method: 'PATCH',
      url: '/api/np/settings',
    });

  it('shows the server message for a 4xx', () => {
    expect(apiErrorMessage(t, failure(400, 'Name is too long.'))).toBe(
      'Name is too long.',
    );
  });

  it('translates known codes', () => {
    expect(apiErrorMessage(t, failure(400, 'x', 'PM_AGENT_NOT_ELIGIBLE'))).toBe(
      'np.entries.errors.notManager',
    );
  });

  it('falls back for forbidden and server errors', () => {
    expect(apiErrorMessage(t, failure(403, 'no'))).toBe('np.common.forbidden');
    expect(apiErrorMessage(t, failure(500, 'boom'))).toBe(
      'np.common.requestFailed',
    );
    expect(apiErrorMessage(t, new Error('offline'))).toBe(
      'np.common.requestFailed',
    );
  });
});

describe('Settings → General entry agents', () => {
  const settings = (
    conversation: string | null,
    completion: string | null,
  ) => ({
    data: {
      canEdit: true,
      agentEntries: {
        revision: 2,
        conversation: {
          agentId: conversation,
          name: 'Assistant',
          instructions: '',
          enabled: true,
        },
        completion: {
          agentId: completion,
          name: 'Completion',
          instructions: '',
          enabled: false,
        },
      },
    },
  });

  it('shows a hint and a create link when there is no project manager', async () => {
    authzDouble.as('admin');
    api.request.mockImplementation(
      answer({
        'GET np/settings': settings(null, null),
        'GET np/workflows': { data: [] },
        'GET np/agents': { data: [CODER] },
      }),
    );
    await renderNp(<GeneralConfigTab />);
    expect(
      await screen.findByText(/No project manager agent is available/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'New project manager' }),
    ).toHaveAttribute('href', '/agents/new?kind=manager');
  });

  it('flags a saved completion agent that is a project manager', async () => {
    authzDouble.as('admin');
    api.request.mockImplementation(
      answer({
        'GET np/settings': settings('m1', 'm1'),
        'GET np/workflows': { data: [] },
        'GET np/agents': { data: [MANAGER, CODER] },
      }),
    );
    await renderNp(<GeneralConfigTab />);
    expect(
      await screen.findByText(/cannot write completion summaries/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No project manager agent/)).toBeNull();
  });

  it('shows the server reason when saving is rejected', async () => {
    authzDouble.as('admin');
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        'GET np/settings': settings('m1', null),
        'GET np/workflows': { data: [] },
        'GET np/agents': { data: [MANAGER] },
        'PATCH np/settings': () => {
          throw new ApiClientError('Entry name is invalid.', {
            status: 400,
            code: 'INVALID_ENTRY',
            method: 'PATCH',
            url: '/api/np/settings',
          });
        },
      }),
    );
    await renderNp(<GeneralConfigTab />);
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: 'Entry name is invalid.',
        }),
      ),
    );
  });
});
