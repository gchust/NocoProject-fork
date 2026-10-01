import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeTypeTag } from '../../client/components/np-runtime-type.js';
import { AgentForm } from '../../client/pages/np/agents/detail/agent-form.js';
import AgentsPage from '../../client/pages/np/agents/index.js';
import NewAgentPage from '../../client/pages/np/agents/new.js';
import BuiltinRuntimePage from '../../client/pages/np/runtimes/builtin.js';
import RuntimesPage from '../../client/pages/np/runtimes/index.js';
import type { AgentListItem } from '../../client/pages/np/types.js';
import { authzDouble } from './np-authz-double.js';
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
vi.mock(
  '@nocobase/app-plugin-authorization/client',
  () => import('./np-authz-double.js'),
);
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('../../client/pages/np/use-realtime.js', () => ({
  useRealtimeTopic: () => undefined,
}));

const COMPUTER_RUNTIME = {
  id: 'r1',
  daemonId: 'd1',
  name: 'studio (claude)',
  provider: 'claude',
  kind: 'personal',
  status: 'online',
  lastSeenAt: new Date().toISOString(),
  deviceInfo: { deviceName: 'studio.local' },
  runtimeType: 'computer',
};

const BUILTIN_RUNTIME = {
  id: 'b1',
  daemonId: 'builtin:deepseek',
  name: 'DeepSeek',
  provider: 'nocobase-ai',
  kind: 'server',
  visibility: 'public',
  pmAllowed: false,
  status: 'offline',
  statusReason: 'check_failed',
  lastSeenAt: null,
  lastCheckedAt: new Date().toISOString(),
  runtimeType: 'builtin',
  llmService: 'deepseek',
  llmServiceTitle: 'DeepSeek',
  enabledModels: [
    { label: 'DeepSeek Chat', value: 'deepseek-chat' },
    { label: 'DeepSeek Reasoner', value: 'deepseek-reasoner' },
  ],
};

const BUILTIN_AGENT: AgentListItem = {
  id: 'a-b',
  name: 'Helper',
  instructions: 'Answer questions.',
  runtimeId: 'b1',
  provider: 'nocobase-ai',
  model: 'deepseek-reasoner',
  kind: 'coder',
  capabilities: ['context.read', 'comment.create'],
  configurationRevision: 2,
  runtimeType: 'builtin',
};

const COMPUTER_AGENT: AgentListItem = {
  id: 'a-c',
  name: 'Coder',
  instructions: 'Write code.',
  runtimeId: 'r1',
  provider: 'claude',
  kind: 'coder',
  capabilities: ['context.read', 'issue.execute'],
  configurationRevision: 1,
};

const USAGE = {
  data: {
    rows: [
      {
        key: 'a-b',
        name: 'Helper',
        runs: 3,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0.25,
      },
    ],
    totals: {
      key: '',
      name: null,
      runs: 3,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0.25,
    },
  },
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
  authzDouble.as('member');
  vi.unstubAllGlobals();
});

describe('the type tag (NP-219 §1)', () => {
  it('names the type and describes it on hover; the icon-only form keeps the name for screen readers', async () => {
    await renderNp(
      <>
        <RuntimeTypeTag type='builtin' />
        <RuntimeTypeTag type='computer' iconOnly />
      </>,
    );
    const builtin = screen.getByText('Built-in agent');
    expect(builtin).toHaveAttribute(
      'title',
      'Works in the system: reads and writes system data, always online',
    );
    expect(
      screen.getByRole('img', { name: 'Computer agent' }),
    ).toBeInTheDocument();
  });
});

describe('runtimes page in two blocks (NP-219 §9.1)', () => {
  function serve(candidates: unknown, runtimes: unknown[]) {
    const requests: RequestOptions[] = [];
    api.request.mockImplementation((options: RequestOptions) => {
      requests.push(options);
      return answer({
        'GET np/runtimes': { data: runtimes },
        'GET np/computers': { data: [] },
        'GET np/agents': { data: [BUILTIN_AGENT, COMPUTER_AGENT] },
        'GET np/usage': USAGE,
        'GET np/runtimes/builtin/candidates': { data: candidates },
        'POST np/runtimes/b1/check': {
          data: { ...BUILTIN_RUNTIME, status: 'online', statusReason: null },
        },
        'DELETE np/runtimes/b1': () =>
          Promise.reject(Object.assign(new Error('in use'), { status: 409 })),
      })(options);
    });
    return requests;
  }

  it('shows computer runtimes and built-in runtimes in their own blocks, each with its own columns', async () => {
    authzDouble.as('admin');
    const requests = serve(
      {
        plugin: 'ready',
        services: [
          {
            llmService: 'deepseek',
            title: 'DeepSeek',
            provider: 'deepseek',
            enabledModels: BUILTIN_RUNTIME.enabledModels,
            runtimeId: 'b1',
          },
        ],
      },
      [COMPUTER_RUNTIME, BUILTIN_RUNTIME],
    );
    await renderNp(<RuntimesPage />, { url: '/runtimes' });

    const computer = within(
      await screen.findByRole('region', { name: 'Computer runtime' }),
    );
    const builtin = within(
      screen.getByRole('region', { name: 'Built-in runtime' }),
    );
    expect(
      computer.getByText(
        'Works on a member’s computer: changes code, runs commands, opens pull requests',
      ),
    ).toBeInTheDocument();
    expect(await computer.findByText('studio.local')).toBeInTheDocument();
    expect(computer.queryByText('DeepSeek')).toBeNull();

    // The built-in row: its service and provider, models, offline with the reason, this month's usage.
    const row = (await builtin.findAllByRole('row')).find((item) =>
      within(item).queryByText('DeepSeek', { selector: 'span.font-medium' }),
    )!;
    expect(row).toHaveTextContent('deepseek');
    expect(row).toHaveTextContent('Offline');
    expect(row).toHaveTextContent('Connection check failed');
    await waitFor(() => expect(row).toHaveTextContent('1.5K tokens · $0.25'));
    expect(
      builtin.getByRole('columnheader', { name: 'Model service' }),
    ).toBeInTheDocument();
    expect(
      computer.queryByRole('columnheader', { name: 'Model service' }),
    ).toBeNull();
    expect(requests).toContainEqual(
      expect.objectContaining({
        path: 'np/usage',
        query: expect.objectContaining({
          groupBy: 'agent',
          runtimeType: 'builtin',
        }),
      }),
    );
  });

  it('tests a connection from the row menu, and names the agents when a runtime in use cannot be deleted', async () => {
    authzDouble.as('admin');
    const user = userEvent.setup();
    serve({ plugin: 'ready', services: [] }, [BUILTIN_RUNTIME]);
    const { ApiClientError } = await import('@nocobase/app-client');
    await renderNp(<RuntimesPage />, { url: '/runtimes' });
    await screen.findByText('1.5K tokens · $0.25');

    await user.click(
      await screen.findByRole('button', { name: 'Actions for DeepSeek' }),
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Test connection' }),
    );
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'DeepSeek is reachable' }),
      ),
    );

    api.request.mockImplementation(
      answer({
        'GET np/runtimes': { data: [BUILTIN_RUNTIME] },
        'GET np/computers': { data: [] },
        'GET np/agents': { data: [BUILTIN_AGENT] },
        'GET np/usage': USAGE,
        'GET np/runtimes/builtin/candidates': {
          data: { plugin: 'ready', services: [] },
        },
        'DELETE np/runtimes/b1': () =>
          Promise.reject(
            new ApiClientError('in use', {
              status: 409,
              code: 'RUNTIME_IN_USE',
              payload: {
                code: 'RUNTIME_IN_USE',
                details: { agentIds: ['a-b'] },
              },
              method: 'DELETE',
              url: '/api/np/runtimes/b1',
            } as never),
          ),
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Actions for DeepSeek' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(
      confirm.getByText('Agents still use this runtime: Helper.'),
    ).toBeInTheDocument();
    await user.click(confirm.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: 'Agents still use this runtime: Helper.',
        }),
      ),
    );
  });

  it('says the AI plugin is not enabled instead of failing, and offers the model services only to managers', async () => {
    const user = userEvent.setup();
    authzDouble.as('admin');
    serve({ plugin: 'missing', services: [] }, [COMPUTER_RUNTIME]);
    const first = await renderNp(<RuntimesPage />, { url: '/runtimes' });
    const builtin = within(
      await screen.findByRole('region', { name: 'Built-in runtime' }),
    );
    expect(
      await builtin.findByText('AI plugin not enabled'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add runtime/ }));
    expect(
      await screen.findByRole('menuitem', { name: 'Connect a computer' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Use a model service' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    first.unmount();

    authzDouble.as('member');
    serve({ plugin: 'ready', services: [] }, [COMPUTER_RUNTIME]);
    await renderNp(<RuntimesPage />, { url: '/runtimes' });
    expect(await screen.findByText('No built-in runtime')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Use a model service' }),
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: /Add runtime/ }));
    expect(
      await screen.findByRole('menuitem', { name: 'Connect a computer' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Use a model service' }),
    ).toBeNull();
  });
});

describe('using a model service (NP-219 §4.1)', () => {
  it('lists the AI plugin’s services, marks the one in use and enables another', async () => {
    authzDouble.as('admin');
    const user = userEvent.setup();
    const posted: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'GET np/runtimes/builtin/candidates': {
          data: {
            plugin: 'ready',
            services: [
              {
                llmService: 'deepseek',
                title: 'DeepSeek',
                provider: 'deepseek',
                enabledModels: [{ label: 'DeepSeek Chat', value: 'chat' }],
                runtimeId: 'b1',
              },
              {
                llmService: 'openai',
                title: 'OpenAI',
                provider: 'openai',
                enabledModels: [{ label: 'GPT-4.1', value: 'gpt-4.1' }],
                runtimeId: null,
              },
            ],
          },
        },
        'POST np/runtimes/builtin': (options: RequestOptions) => {
          posted.push(options.json);
          return { data: { ...BUILTIN_RUNTIME, id: 'b2', name: 'OpenAI' } };
        },
      }),
    );
    await renderNpRoutes(
      <Route path='/runtimes' element={<Outlet />}>
        <Route path='builtin' element={<BuiltinRuntimePage />} />
      </Route>,
      { url: '/runtimes/builtin' },
    );
    const list = within(
      await screen.findByRole('list', { name: 'Model services' }),
    );
    const [deepseek, openai] = list.getAllByRole('listitem');
    expect(deepseek).toHaveTextContent('In use');
    expect(within(deepseek!).queryByRole('button')).toBeNull();
    expect(openai).toHaveTextContent('1 models: GPT-4.1');
    await user.click(within(openai!).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(posted).toEqual([{ llmService: 'openai' }]));
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'OpenAI is in use' }),
    );
    expect(
      screen.getByRole('button', { name: 'Open AI settings' }),
    ).toHaveAttribute('href', '/settings/ai/llm-services');
  });

  it('explains where model services come from when the AI plugin has none', async () => {
    authzDouble.as('admin');
    api.request.mockImplementation(
      answer({
        'GET np/runtimes/builtin/candidates': {
          data: { plugin: 'ready', services: [] },
        },
      }),
    );
    await renderNpRoutes(
      <Route path='/runtimes' element={<Outlet />}>
        <Route path='builtin' element={<BuiltinRuntimePage />} />
      </Route>,
      { url: '/runtimes/builtin' },
    );
    expect(
      await screen.findByText('No model service available'),
    ).toBeInTheDocument();
  });
});

describe('a new agent starts from its type (NP-219 §9.1)', () => {
  it('keeps the built-in type disabled, with the reason, while no built-in runtime is in use', async () => {
    api.request.mockImplementation(
      answer({ 'GET np/runtimes': { data: [COMPUTER_RUNTIME] } }),
    );
    await renderNp(<NewAgentPage />, {
      url: '/agents/new',
      path: '/agents/new',
    });
    const builtin = await screen.findByRole('radio', {
      name: /^Built-in agent/,
    });
    await waitFor(() =>
      expect(builtin).toHaveAttribute('aria-disabled', 'true'),
    );
    expect(
      screen.getByText('No Built-in runtime is in use yet.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The type cannot be changed after the agent is created; to switch, create a new agent.',
      ),
    ).toBeInTheDocument();
  });

  it('filters runtimes, models and capabilities by the type and sends it', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'GET np/runtimes': {
          data: [COMPUTER_RUNTIME, { ...BUILTIN_RUNTIME, status: 'online' }],
        },
        'POST np/agents': (options: RequestOptions) => {
          posted.push(options.json);
          return { data: { id: 'n', name: 'Triage' } };
        },
      }),
    );
    await renderNp(<NewAgentPage />, {
      url: '/agents/new?runtimeType=builtin',
      path: '/agents/new',
    });
    expect(
      await screen.findByRole('radio', { name: /^Built-in agent/ }),
    ).toBeChecked();
    await user.type(
      await screen.findByRole('textbox', { name: 'Name' }),
      'Triage',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Instructions' }),
      'Sort new issues.',
    );
    // No reasoning effort for a built-in agent.
    expect(
      screen.queryByRole('combobox', { name: 'Reasoning effort' }),
    ).toBeNull();

    await user.click(screen.getByRole('combobox', { name: 'Runtime' }));
    expect(
      await screen.findByRole('option', { name: /DeepSeek/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /studio/ })).toBeNull();
    await user.click(screen.getByRole('option', { name: /DeepSeek/ }));

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(
      await screen.findByRole('option', {
        name: 'Service default (DeepSeek Chat)',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'DeepSeek Reasoner' }));

    // Capabilities a built-in agent cannot hold stay listed, disabled, with the reason.
    await user.click(screen.getByRole('combobox', { name: 'Capabilities' }));
    const execute = await screen.findByRole('option', {
      name: /Execute tasks/,
    });
    expect(execute).toHaveAttribute('aria-disabled', 'true');
    expect(execute).toHaveTextContent('Built-in agent: not available');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(posted).toEqual([
        expect.objectContaining({
          runtimeType: 'builtin',
          runtimeId: 'b1',
          provider: 'nocobase-ai',
          model: 'deepseek-reasoner',
          reasoningEffort: null,
        }),
      ]),
    );
  });

  it('says why the server refused the type', async () => {
    const user = userEvent.setup();
    const { ApiClientError } = await import('@nocobase/app-client');
    api.request.mockImplementation(
      answer({
        'GET np/runtimes': {
          data: [COMPUTER_RUNTIME, { ...BUILTIN_RUNTIME, status: 'online' }],
        },
        'POST np/agents': () =>
          Promise.reject(
            new ApiClientError('unavailable', {
              status: 400,
              code: 'BUILTIN_RUNTIME_UNAVAILABLE',
              payload: { code: 'BUILTIN_RUNTIME_UNAVAILABLE' },
              method: 'POST',
              url: '/api/np/agents',
            } as never),
          ),
      }),
    );
    await renderNp(<NewAgentPage />, {
      url: '/agents/new?runtimeType=builtin',
      path: '/agents/new',
    });
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'X');
    await user.type(screen.getByRole('textbox', { name: 'Instructions' }), 'Y');
    await user.click(screen.getByRole('combobox', { name: 'Runtime' }));
    await user.click(await screen.findByRole('option', { name: /DeepSeek/ }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText('The AI plugin is not enabled.'),
    ).toBeInTheDocument();
  });
});

describe('an agent’s settings follow its type (NP-219 §9.1)', () => {
  it('shows the type read-only and offers only runtimes of the same type, models of its service and computer delegation targets', async () => {
    const user = userEvent.setup();
    const patched: unknown[] = [];
    api.request.mockImplementation(
      answer({
        'PATCH np/agents/a-b': (options: RequestOptions) => {
          patched.push(options.json);
          return { data: BUILTIN_AGENT };
        },
      }),
    );
    await renderNp(
      <AgentForm
        agent={BUILTIN_AGENT}
        runtimes={[COMPUTER_RUNTIME as never, BUILTIN_RUNTIME as never]}
        agents={[
          BUILTIN_AGENT,
          COMPUTER_AGENT,
          { ...BUILTIN_AGENT, id: 'a-b2', name: 'Other helper' },
        ]}
        members={[]}
        canEdit
      />,
    );
    expect(screen.getByRole('group', { name: 'Type' })).toHaveTextContent(
      'Built-in agent',
    );
    expect(
      screen.queryByRole('combobox', { name: 'Reasoning effort' }),
    ).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent(
      'DeepSeek Reasoner',
    );

    await user.click(screen.getByRole('combobox', { name: 'Runtime' }));
    expect(
      await screen.findByRole('option', { name: /DeepSeek/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /studio/ })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(
      screen.getByRole('combobox', { name: 'Can hand sub-issues to' }),
    );
    expect(
      await screen.findByRole('option', { name: 'Coder' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Other helper' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patched).toEqual([
        expect.objectContaining({
          model: 'deepseek-reasoner',
          reasoningEffort: null,
        }),
      ]),
    );
  });
});

describe('the agent list shows and filters the type (NP-219 §9.1)', () => {
  it('tags every agent with its type and filters by it', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        'GET np/agents': { data: [BUILTIN_AGENT, COMPUTER_AGENT] },
      }),
    );
    await renderNp(<AgentsPage />, { url: '/agents' });
    const table = await screen.findByRole('table');
    const helper = within(table)
      .getByRole('link', { name: 'Helper' })
      .closest('tr')!;
    const coder = within(table)
      .getByRole('link', { name: 'Coder' })
      .closest('tr')!;
    expect(helper).toHaveTextContent('Built-in agent');
    expect(coder).toHaveTextContent('Computer agent');

    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(
      await screen.findByRole('option', { name: 'Built-in agent' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Coder' })).toBeNull(),
    );
    expect(screen.getByRole('link', { name: 'Helper' })).toBeInTheDocument();
  });
});
