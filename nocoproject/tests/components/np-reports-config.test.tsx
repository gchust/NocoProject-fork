import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ConfigPage from '../../client/pages/np/config/index.js';
import GeneralConfigTab from '../../client/pages/np/config/general.js';
import GithubConfigTab from '../../client/pages/np/config/github.js';
import LabelsConfigTab from '../../client/pages/np/config/labels.js';
import WorkflowDetailPage from '../../client/pages/np/config/workflow-detail.js';
import MetricsReportTab from '../../client/pages/np/reports/metrics.js';
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
  useService: () => ({ subscribe: () => () => {}, onOpen: () => () => {} }),
}));
vi.mock('@/components/ui/toast', () => ({ toast }));

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
});

const members = (role: 'owner' | 'member') => ({
  'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
  'GET np/members': {
    data: [{ userId: 'u1', name: 'Zhou', email: null, role }],
  },
});

describe('metrics report (§C)', () => {
  it('renders the six groups with status badges from the server and the thresholds', async () => {
    api.request.mockImplementation(
      answer({
        'GET np/projects': { data: [] },
        'GET np/metrics': {
          data: {
            adoption: {
              activeWeeks: 3,
              activeDays: 12,
              issuesCreated: 40,
              activeMembers: 4,
            },
            aiShare: { deliveredByAgent: 6, deliveredTotal: 20, share: 0.3 },
            trust: {
              proposalAcceptRate: 0.9,
              reviewPassRate: 0.8,
              approvalApproveRate: null,
              reworkRate: 0.1,
            },
            reliability: {
              runs: 30,
              failedRuns: 2,
              failuresByReason: { timeout: 2 },
              claimLatencyP50Ms: 1200,
              claimLatencyP95Ms: 4000,
              runDurationP50Ms: 90_000,
              lostRuns: 0,
            },
            cost: {
              inputTokens: 120_000,
              outputTokens: 30_000,
              estimatedCost: 3.5,
              costPerDeliveredIssue: 0.175,
              byAgent: [{ agentId: 'a1', name: 'Claude Coder', cost: 3.5 }],
            },
            humanLoad: {
              decisionsCreated: 10,
              decisionsResolved: 8,
              decisionResolveP50Ms: null,
              openDecisions: 2,
              byType: { review_requested: 7 },
            },
            thresholds: { aiShare: 0.5 },
            statuses: {
              aiShare: 'warn',
              proposalAcceptRate: 'ok',
              claimLatencyP50Ms: 'ok',
              lostRuns: 'ok',
              decisionResolveP50Ms: 'n/a',
            },
          },
        },
      }),
    );
    const { container } = await renderNp(<MetricsReportTab />, {
      url: '/reports/metrics?from=2026-09-01&to=2026-09-27',
    });

    expect(
      await screen.findByRole('heading', { name: 'AI share' }),
    ).toBeVisible();
    for (const group of [
      'Adoption',
      'Trust',
      'Reliability',
      'Cost',
      'Human load',
    ]) {
      expect(screen.getByRole('heading', { name: group })).toBeVisible();
    }
    const share = container.querySelector(
      '[data-metric="share"]',
    ) as HTMLElement;
    expect(within(share).getByText('30%')).toBeVisible();
    expect(within(share).getByText('Off target')).toBeVisible();
    expect(within(share).getByText('Target ≥ 50%')).toBeVisible();
    const accept = container.querySelector(
      '[data-metric="proposalAcceptRate"]',
    ) as HTMLElement;
    expect(within(accept).getByText('On target')).toBeVisible();
    const resolve = container.querySelector(
      '[data-metric="decisionResolveP50Ms"]',
    ) as HTMLElement;
    expect(within(resolve).getByText('No data')).toBeVisible();
    // Unthresholded metrics carry no badge.
    const runs = container.querySelector('[data-metric="runs"]') as HTMLElement;
    expect(within(runs).queryByText(/target|No data/u)).toBeNull();
    expect(screen.getByText('Off target: 1')).toBeVisible();
    expect(screen.getByText('Claude Coder')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/metrics',
        query: { from: '2026-09-01', to: '2026-09-27', projectId: undefined },
      }),
    );
  });
});

const WORKFLOW = {
  id: 'w1',
  name: '软件开发',
  isDefault: true,
  projectCount: 3,
  definition: {
    statuses: [
      {
        key: 'todo',
        name: 'Todo',
        category: 'unstarted',
        color: 'blue',
        builtIn: true,
      },
      {
        key: 'in_review',
        name: 'In Review',
        category: 'started',
        color: 'purple',
        builtIn: true,
      },
      {
        key: 'done',
        name: 'Done',
        category: 'done',
        color: 'green',
        builtIn: true,
      },
      {
        key: 'cancelled',
        name: 'Cancelled',
        category: 'closed',
        color: 'gray',
        builtIn: true,
      },
    ],
    transitions: [
      { from: '*', to: '*', actors: ['user'] },
      {
        from: 'in_review',
        to: 'done',
        actors: ['agent'],
        approval: { approvers: ['owner'] },
      },
    ],
    childBatchDoneWakesParentExecutor: true,
  },
};

describe('workflow template (§F)', () => {
  it('shows the flow, the matrix with actor icons and an approval badge, the rules and the project count', async () => {
    api.request.mockImplementation(
      answer({ 'GET np/workflows/w1': { data: WORKFLOW } }),
    );
    const { container } = await renderNp(<WorkflowDetailPage />, {
      url: '/config/workflows/w1',
      path: '/config/workflows/:workflowId',
    });

    expect(await screen.findByText('Projects using it: 3')).toBeVisible();
    expect(screen.getByText('Default')).toBeVisible();
    const main = screen.getByRole('list', { name: 'Main status line' });
    expect(within(main).getAllByRole('listitem')).toHaveLength(3);
    expect(
      within(screen.getByRole('list', { name: 'Side branches' })).getByText(
        'Cancelled',
      ),
    ).toBeVisible();

    const cell = container.querySelector(
      'td[data-from="in_review"][data-to="done"]',
    ) as HTMLElement;
    expect(within(cell).getByText('People')).toBeInTheDocument();
    expect(within(cell).getByText('Agents')).toBeInTheDocument();
    expect(within(cell).getByText('Approval')).toBeVisible();
    const plain = container.querySelector(
      'td[data-from="todo"][data-to="done"]',
    ) as HTMLElement;
    expect(within(plain).queryByText('Approval')).toBeNull();
    expect(within(plain).queryByText('Agents')).toBeNull();

    expect(screen.getByText('Needs approval by the issue owner')).toBeVisible();
    expect(
      screen.getByText(
        'When a stage of sub-issues is done, the parent issue’s agent is woken up.',
      ),
    ).toBeVisible();
  });
});

describe('settings in the front end (§G)', () => {
  function configRoutes() {
    return (
      <Route path='/config' element={<ConfigPage />}>
        <Route path='general' element={<GeneralConfigTab />} />
        <Route path='labels' element={<LabelsConfigTab />} />
        <Route path='github' element={<GithubConfigTab />} />
      </Route>
    );
  }

  it('shows all five tabs to an owner and redirects the bare URL to General', async () => {
    api.request.mockImplementation(
      answer({
        ...members('owner'),
        'GET np/settings': { data: { canEdit: true, prMergedStatus: 'done' } },
        'GET np/workflows': { data: [] },
      }),
    );
    await renderNpRoutes(configRoutes(), { url: '/config' });
    const tabs = await screen.findByRole('navigation', {
      name: 'Settings sections',
    });
    await waitFor(() =>
      expect(
        within(tabs)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual([
        'General',
        'Members',
        'Workflow templates',
        'Labels',
        'GitHub',
      ]),
    );
    expect(within(tabs).getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('button', { name: 'Save' })).toBeVisible();
    expect(screen.getByLabelText('Delivered by agents, at least')).toHaveValue(
      '50',
    );
  });

  it('gives a member read-only settings and no GitHub tab', async () => {
    api.request.mockImplementation(
      answer({
        ...members('member'),
        'GET np/settings': { data: { canEdit: false } },
        'GET np/workflows': { data: [] },
        'GET np/me/preferences': { data: { inboxChime: true } },
      }),
    );
    await renderNpRoutes(configRoutes(), { url: '/config/general' });
    expect(
      await screen.findByText(
        'Workspace settings. Owners and admins make changes; you can read them.',
      ),
    ).toBeVisible();
    const tabs = screen.getByRole('navigation', { name: 'Settings sections' });
    await waitFor(() =>
      expect(within(tabs).queryByRole('link', { name: 'GitHub' })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    // Workspace switches are read-only; the viewer's own sound reminder stays editable (NP-108).
    const chime = screen.getByRole('switch', { name: 'Sound reminder' });
    await waitFor(() => expect(chime).not.toHaveAttribute('data-disabled'));
    for (const control of screen.getAllByRole('switch')) {
      if (control !== chime) expect(control).toHaveAttribute('data-disabled');
    }
  });

  it('edits the default process, the project manager and the retrospective switch (iteration 4)', async () => {
    const user = userEvent.setup();
    const patched: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...members('owner'),
        'GET np/settings': {
          data: {
            canEdit: true,
            defaultProcess: 'auto',
            pmAgentId: null,
            retrospectiveOnDone: true,
          },
        },
        'GET np/workflows': { data: [] },
        'GET np/agents': {
          data: [
            {
              id: 'a1',
              name: 'Claude Coder',
              provider: 'claude',
              runtimeId: 'r1',
            },
            {
              id: 'pm',
              name: 'Project Manager',
              provider: 'opencode',
              runtimeId: 'r1',
              kind: 'manager',
              capabilities: ['comment.create'],
              canInvoke: true,
            },
          ],
        },
        'PATCH np/settings': (options: RequestOptions) => {
          patched.push(options.json);
          return { data: options.json };
        },
      }),
    );
    await renderNpRoutes(configRoutes(), { url: '/config/general' });
    const agentSelect = (
      await screen.findAllByRole('combobox', { name: 'Agent' })
    )[0];
    await user.click(agentSelect);
    expect(
      await screen.findByRole('option', { name: 'Project Manager' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Claude Coder' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Project Manager' }));
    await user.click(screen.getByRole('combobox', { name: 'Default process' }));
    await user.click(
      await screen.findByRole('option', { name: 'Design first' }),
    );
    await user.click(screen.getAllByRole('switch', { name: 'Enabled' })[1]);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patched).toEqual([
        expect.objectContaining({
          defaultProcess: 'design_first',
          agentEntries: expect.objectContaining({
            conversation: expect.objectContaining({ agentId: 'pm' }),
            completion: expect.objectContaining({ enabled: true }),
          }),
        }),
      ]),
    );
  });

  it('shows labels read-only to a member and manageable to an owner', async () => {
    const user = userEvent.setup();
    const created: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...members('member'),
        'GET np/labels': { data: [{ id: 'l1', name: 'bug', color: 'red' }] },
      }),
    );
    const first = await renderNp(<LabelsConfigTab />);
    expect(await screen.findByText('bug')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete bug' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create label' })).toBeNull();
    first.unmount();

    api.request.mockImplementation(
      answer({
        ...members('owner'),
        'GET np/labels': { data: [{ id: 'l1', name: 'bug', color: 'red' }] },
        'POST np/labels': (options: RequestOptions) => {
          created.push(options.json);
          return { data: { id: 'l2', name: 'docs', color: 'gray' } };
        },
        'DELETE np/labels/l1': { data: { ok: true } },
      }),
    );
    await renderNp(<LabelsConfigTab />);
    await user.type(
      await screen.findByRole('textbox', { name: 'New label name' }),
      'docs',
    );
    await user.click(screen.getByRole('button', { name: 'Create label' }));
    await waitFor(() =>
      expect(created).toEqual([{ name: 'docs', color: 'gray' }]),
    );

    await user.click(screen.getByRole('button', { name: 'Delete bug' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete label' }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'np/labels/l1', method: 'DELETE' }),
      ),
    );
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        title: 'Label "bug" deleted',
      }),
    );
  });

  it('lets an admin reveal secrets and shows a generated webhook secret until it is saved', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...members('owner'),
        'GET np/integrations/github': {
          data: {
            configured: true,
            apiBaseUrl: 'https://api.github.com',
            tokenSet: true,
            webhookSecretSet: true,
            webhookUrl: 'https://np.example.com/np/webhooks/github',
            lastEventAt: null,
          },
        },
        'PUT np/integrations/github': (options: RequestOptions) => {
          saved.push(options.json);
          return {
            data: {
              configured: true,
              apiBaseUrl: 'https://api.github.com',
              tokenSet: true,
              webhookSecretSet: true,
              webhookUrl: 'https://np.example.com/np/webhooks/github',
              lastEventAt: null,
            },
          };
        },
      }),
    );
    await renderNp(<GithubConfigTab />);
    const token = await screen.findByLabelText('Token', { exact: false });
    expect(token).toHaveAttribute('type', 'password');
    const [showToken] = screen.getAllByRole('button', { name: 'Show value' });
    await user.click(showToken);
    expect(token).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    const secret = document.getElementById(
      'np-github-secret',
    ) as HTMLInputElement;
    expect(secret.type).toBe('text');
    expect(secret.value).toMatch(/^[0-9a-f]{64}$/u);
    expect(screen.getByText(/gh webhook forward/u)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toEqual([
        { webhookSecret: secret.value || expect.any(String) },
      ]),
    );
    await waitFor(() => expect(secret.value).toBe(''));
    expect(secret.type).toBe('password');
  });

  it('explains the GitHub tab to a member instead of failing with 403', async () => {
    api.request.mockImplementation(answer({ ...members('member') }));
    await renderNp(<GithubConfigTab />);
    expect(await screen.findByText('Owners and admins only')).toBeVisible();
    expect(api.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'np/integrations/github' }),
    );
  });
});
