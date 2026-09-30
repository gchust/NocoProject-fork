import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentForm } from '../../client/pages/np/agents/detail/agent-form.js';
import GeneralConfigTab from '../../client/pages/np/config/general.js';
import UsagePage from '../../client/pages/np/reports/usage.js';
import RuntimesPage from '../../client/pages/np/runtimes/index.js';
import type { AgentListItem } from '../../client/pages/np/types.js';
import type { PmAgentChoice } from '../../client/pages/np/types-pm.js';
import { PmAgentSection } from '../../client/pages/profile/pm-agent-section.js';
import { PmConfirmPreference } from '../../client/pages/profile/pm-confirm-preference.js';
import { authzDouble } from './np-authz-double.js';
import { answer, type RequestOptions, renderNp } from './np-harness.js';

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

const CHOICE: PmAgentChoice = {
  mode: 'system',
  agentId: null,
  revision: 4,
  allowPersonal: true,
  systemAgent: {
    id: 'sys',
    name: 'Workspace PM',
    provider: 'claude',
    model: null,
    online: true,
  },
  candidates: [
    {
      id: 'mine',
      name: 'My PM',
      provider: 'claude',
      model: 'sonnet',
      runtimeName: 'laptop',
      online: true,
    },
  ],
  eligibleRuntimes: [
    { id: 'rt1', name: 'laptop (claude)', online: true, shared: false },
  ],
};

const refusal = (reason: string) =>
  new ApiClientError('Not eligible', {
    status: 400,
    code: 'PM_AGENT_NOT_ELIGIBLE',
    method: 'PUT',
    url: '/api/np/me/pm-agent',
    payload: { details: { reason } },
  });

describe('my project manager on the profile page (NP-183 §6.2)', () => {
  it('saves a personal choice with the revision and shows the data boundary note', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'GET np/me/pm-agent': { data: CHOICE },
        'PUT np/me/pm-agent': (options: RequestOptions) => {
          saved.push(options.json);
          return {
            data: { ...CHOICE, mode: 'personal', agentId: 'mine', revision: 5 },
          };
        },
      }),
    );
    await renderNp(<PmAgentSection />);

    expect(
      await screen.findByRole('radio', { name: 'System default' }),
    ).toBeChecked();
    expect(
      screen.getByText(/go to the model provider configured on that computer/),
    ).toBeVisible();
    const save = screen.getByRole('button', { name: 'Save choice' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'My PM' }));
    await user.click(save);
    await waitFor(() =>
      expect(saved).toEqual([
        { revision: 4, mode: 'personal', agentId: 'mine' },
      ]),
    );
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success' }),
      ),
    );
    expect(screen.getByRole('radio', { name: 'My PM' })).toBeChecked();
  });

  it.each([
    ['personalDisabled', 'does not allow personal project managers'],
    ['notPrivate', 'usable by its owner only'],
    ['foreignRuntime', 'not yours'],
  ])('says in words why %s is refused', async (reason, words) => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        'GET np/me/pm-agent': { data: CHOICE },
        'PUT np/me/pm-agent': () => Promise.reject(refusal(reason)),
      }),
    );
    await renderNp(<PmAgentSection />);
    await user.click(await screen.findByRole('radio', { name: 'My PM' }));
    await user.click(screen.getByRole('button', { name: 'Save choice' }));

    expect(await screen.findByText(new RegExp(words))).toBeVisible();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('hides the personal choice and the copy action while personal managers are off', async () => {
    api.request.mockImplementation(
      answer({
        'GET np/me/pm-agent': {
          data: { ...CHOICE, allowPersonal: false, candidates: [] },
        },
      }),
    );
    await renderNp(<PmAgentSection />);

    expect(
      await screen.findByRole('radio', { name: 'System default' }),
    ).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.queryByText('Copy from default')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Your workspace uses the system default project manager.',
      ),
    ).toBeVisible();
  });

  it('copies the default onto a runtime with the chosen model and effort', async () => {
    const user = userEvent.setup();
    const copied: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'GET np/me/pm-agent': { data: CHOICE },
        'POST np/me/pm-agent/copy-from-default': (options: RequestOptions) => {
          copied.push(options.json);
          return {
            data: {
              agent: { id: 'new', name: 'Workspace PM (mine)' },
              choice: {
                ...CHOICE,
                mode: 'personal',
                agentId: 'new',
                revision: 5,
              },
            },
          };
        },
        'GET np/agents': { data: [] },
      }),
    );
    await renderNp(<PmAgentSection />);
    const copy = await screen.findByRole('button', {
      name: 'Copy from default',
    });
    expect(copy).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Runtime' }));
    await user.click(
      await screen.findByRole('option', { name: 'laptop (claude)' }),
    );
    await user.type(screen.getByRole('textbox', { name: 'Model' }), 'sonnet');
    await user.click(
      screen.getByRole('combobox', { name: 'Reasoning effort' }),
    );
    await user.click(await screen.findByRole('option', { name: 'High' }));
    await user.click(copy);

    await waitFor(() =>
      expect(copied).toEqual([
        { runtimeId: 'rt1', model: 'sonnet', reasoningEffort: 'high' },
      ]),
    );
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          title: 'Workspace PM (mine) created and chosen',
        }),
      ),
    );
  });

  it('shows the refusal when the copy is not allowed', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        'GET np/me/pm-agent': { data: CHOICE },
        'POST np/me/pm-agent/copy-from-default': () =>
          Promise.reject(refusal('foreignRuntime')),
      }),
    );
    await renderNp(<PmAgentSection />);
    await user.click(await screen.findByRole('combobox', { name: 'Runtime' }));
    await user.click(
      await screen.findByRole('option', { name: 'laptop (claude)' }),
    );
    await user.click(screen.getByRole('button', { name: 'Copy from default' }));

    expect(await screen.findByText(/not yours/)).toBeVisible();
  });
});

describe('"Always confirm first" (NP-183 §6.4)', () => {
  it('saves the switch with the preferences revision', async () => {
    const user = userEvent.setup();
    const patched: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'GET np/me/preferences': {
          data: { inboxChime: true, pmConfirmAll: false, revision: 7 },
        },
        'PATCH np/me/preferences': (options: RequestOptions) => {
          patched.push(options.json);
          return {
            data: { inboxChime: true, pmConfirmAll: true, revision: 8 },
          };
        },
      }),
    );
    await renderNp(<PmConfirmPreference />);
    const toggle = await screen.findByRole('switch', {
      name: 'Always confirm first',
    });
    await waitFor(() => expect(toggle).not.toHaveAttribute('data-disabled'));
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);
    await waitFor(() =>
      expect(patched).toEqual([{ revision: 7, pmConfirmAll: true }]),
    );
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('keeps the switch off and says so when saving fails', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        'GET np/me/preferences': {
          data: { inboxChime: true, pmConfirmAll: false, revision: 7 },
        },
        'PATCH np/me/preferences': () => Promise.reject(new Error('stale')),
      }),
    );
    await renderNp(<PmConfirmPreference />);
    const toggle = await screen.findByRole('switch', {
      name: 'Always confirm first',
    });
    await waitFor(() => expect(toggle).not.toHaveAttribute('data-disabled'));
    await user.click(toggle);
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      ),
    );
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});

describe('personal project managers in Settings → General (NP-183 §6.1)', () => {
  const settings = (allowPersonal: boolean | undefined) => ({
    data: {
      canEdit: true,
      agentEntries: {
        revision: 2,
        conversation: {
          agentId: 'sys',
          name: 'Assistant',
          instructions: '',
          enabled: true,
          ...(allowPersonal === undefined ? {} : { allowPersonal }),
        },
        completion: {
          agentId: null,
          name: 'Completion',
          instructions: '',
          enabled: false,
        },
      },
    },
  });

  it('saves the switch with the entries', async () => {
    authzDouble.as('admin');
    const user = userEvent.setup();
    const patched: { agentEntries?: { conversation?: unknown } }[] = [];
    api.request.mockImplementation(
      answer({
        'GET np/settings': settings(false),
        'GET np/workflows': { data: [] },
        'GET np/agents': { data: [] },
        'PATCH np/settings': (options: RequestOptions) => {
          patched.push(options.json as never);
          return settings(true);
        },
      }),
    );
    await renderNp(<GeneralConfigTab />);
    const toggle = await screen.findByRole('switch', {
      name: 'Personal project managers',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]?.agentEntries?.conversation).toMatchObject({
      allowPersonal: true,
      agentId: 'sys',
    });
  });

  it('is disabled for someone who cannot change the settings', async () => {
    authzDouble.as('member');
    api.request.mockImplementation(
      answer({
        'GET np/settings': { data: { ...settings(true).data, canEdit: false } },
        'GET np/workflows': { data: [] },
        'GET np/agents': { data: [] },
      }),
    );
    await renderNp(<GeneralConfigTab />);
    const toggle = await screen.findByRole('switch', {
      name: 'Personal project managers',
    });
    expect(toggle).toHaveAttribute('data-disabled');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});

describe('runtimes that may run personal project managers (NP-183 §6.3)', () => {
  const runtime = (
    id: string,
    visibility: 'public' | 'private',
    pm: boolean,
  ) => ({
    id,
    daemonId: `${id}-d`,
    name: `${id} (claude)`,
    provider: 'claude',
    kind: 'personal',
    visibility,
    pmAllowed: pm,
    status: 'online',
    lastSeenAt: new Date().toISOString(),
    version: '2.1.0',
    deviceInfo: { deviceName: `${id}-mac` },
    daemon: null,
  });
  const routes = (patched: unknown[]) => ({
    'GET np/runtimes': {
      data: [
        runtime('shared', 'public', false),
        runtime('mine', 'private', false),
      ],
    },
    'GET np/computers': { data: [] },
    'PATCH np/runtimes/shared': (options: RequestOptions) => {
      patched.push(options.json);
      return { data: runtime('shared', 'public', true) };
    },
  });

  it('lets an admin allow a public runtime and offers nothing on a private one', async () => {
    authzDouble.as('admin');
    const user = userEvent.setup();
    const patched: unknown[] = [];
    api.request.mockImplementation(answer(routes(patched)));
    await renderNp(<RuntimesPage />);

    const toggle = await screen.findByRole('switch', {
      name: 'Allow personal project managers on shared (claude)',
    });
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    await user.click(toggle);
    await waitFor(() => expect(patched).toEqual([{ pmAllowed: true }]));
  });

  it('shows the state as text to a member', async () => {
    authzDouble.as('member');
    api.request.mockImplementation(answer(routes([])));
    await renderNp(<RuntimesPage />);

    expect(await screen.findByText('Not allowed')).toBeVisible();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('agent form: good at and project manager capabilities (NP-183 §7.2)', () => {
  const base: AgentListItem = {
    id: 'a1',
    name: 'Coder',
    instructions: 'Write code.',
    runtimeId: 'r1',
    provider: 'claude',
    kind: 'coder',
    summary: 'React pages',
    capabilities: ['context.read', 'comment.create'],
    configurationRevision: 3,
  };
  const runtimes = [
    {
      id: 'r1',
      name: 'dev',
      provider: 'claude',
      kind: 'personal',
      status: 'online',
      lastSeenAt: null,
    },
  ] as never;

  it('saves an edited summary', async () => {
    const user = userEvent.setup();
    const patched: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'PATCH np/agents/a1': (options: RequestOptions) => {
          patched.push(options.json);
          return { data: { ...base, name: 'Coder' } };
        },
      }),
    );
    await renderNp(
      <AgentForm
        agent={base}
        runtimes={runtimes}
        agents={[base]}
        members={[]}
        canEdit
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Good at' });
    expect(field).toHaveValue('React pages');
    await user.clear(field);
    await user.type(field, 'Database migrations');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patched).toEqual([
        expect.objectContaining({ summary: 'Database migrations' }),
      ]),
    );
  });

  it('refuses a summary over 200 characters before sending it', async () => {
    const user = userEvent.setup();
    await renderNp(
      <AgentForm
        agent={base}
        runtimes={runtimes}
        agents={[base]}
        members={[]}
        canEdit
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Good at' });
    await user.clear(field);
    await user.click(field);
    await user.paste('x'.repeat(201));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Keep it to 200 characters.')).toBeVisible();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('shows the server’s INVALID_SUMMARY', async () => {
    const user = userEvent.setup();
    api.request.mockRejectedValue(
      new ApiClientError('Invalid', {
        status: 400,
        code: 'INVALID_SUMMARY',
        method: 'PATCH',
        url: '/api/np/agents/a1',
      }),
    );
    await renderNp(
      <AgentForm
        agent={base}
        runtimes={runtimes}
        agents={[base]}
        members={[]}
        canEdit
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Keep it to 200 characters.')).toBeVisible();
  });

  it('shows a project manager agent’s fixed capabilities read-only and sends that set', async () => {
    const user = userEvent.setup();
    const patched: { capabilities?: string[] }[] = [];
    api.request.mockImplementation(
      answer({
        'PATCH np/agents/a1': (options: RequestOptions) => {
          patched.push(options.json as never);
          return { data: base };
        },
      }),
    );
    const manager: AgentListItem = {
      ...base,
      kind: 'manager',
      capabilities: [],
    };
    await renderNp(
      <AgentForm
        agent={manager}
        runtimes={runtimes}
        agents={[manager]}
        members={[]}
        canEdit
      />,
    );
    expect(
      screen.getByText(
        'A project manager agent always holds these capabilities.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect([...(patched[0]?.capabilities ?? [])].sort()).toEqual([
      'comment.create',
      'context.read',
      'knowledge.propose',
      'member.act',
      'repo.read',
      'workspace.read',
    ]);
  });
});

describe('usage by person and by project manager conversations (NP-183 §6.6)', () => {
  const row = (key: string, name: string | null, runs: number) => ({
    key,
    name,
    runs,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 1,
  });

  it('groups by person and by conversation, the pm row unlinked', async () => {
    const user = userEvent.setup();
    const queries: Record<string, unknown>[] = [];
    api.request.mockImplementation((options: RequestOptions) => {
      queries.push(options.query ?? {});
      const groupBy = options.query?.groupBy;
      return Promise.resolve({
        data:
          groupBy === 'actor'
            ? {
                rows: [row('u1', 'Ada', 3), row('none', null, 1)],
                totals: row('total', 'Total', 4),
              }
            : groupBy === 'conversation'
              ? {
                  rows: [row('pm', null, 5), row('a1', 'Coder', 2)],
                  totals: row('total', 'Total', 7),
                }
              : { rows: [], totals: row('total', 'Total', 0) },
      });
    });
    await renderNp(<UsagePage />, {
      url: '/usage?from=2026-09-01&to=2026-09-27',
    });

    await user.click(await screen.findByRole('tab', { name: 'Person' }));
    const people = await screen.findByText('Ada');
    expect(people).toBeVisible();
    expect(screen.getByText('No member')).toBeVisible();
    expect(queries.at(-1)).toMatchObject({ groupBy: 'actor' });

    await user.click(
      screen.getByRole('tab', { name: 'Project manager conversations' }),
    );
    const table = await screen.findByRole('table');
    await waitFor(() =>
      expect(
        within(table).getByText('Project manager conversations', {
          selector: 'td',
        }),
      ).toBeVisible(),
    );
    expect(
      within(table).queryByRole('link', { name: /Project manager/ }),
    ).toBeNull();
    expect(within(table).getByRole('link', { name: 'Coder' })).toHaveAttribute(
      'href',
      '/agents/a1',
    );
    expect(queries.at(-1)).toMatchObject({ groupBy: 'conversation' });
  });
});
