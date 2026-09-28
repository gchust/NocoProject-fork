import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import locales from '../../client/locales/index.js';
import { ProposalsCard } from '../../client/pages/np/issues/detail/proposals-card.js';
import type {
  AgentListItem,
  ExecutorProposal,
} from '../../client/pages/np/types.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));
vi.mock('@/components/ui/toast', () => ({ toast }));

const NOW = '2026-09-27T10:00:00.000Z';

function proposal(overrides: Partial<ExecutorProposal>): ExecutorProposal {
  return {
    id: 'p1',
    issueId: 's1',
    issueIdentifier: 'NP-11',
    issueTitle: 'Write the migration',
    proposedAgentId: 'a1',
    proposedAgentName: 'Claude Coder',
    proposedByAgentId: 'a9',
    proposedByAgentName: 'Planner',
    sourceRunId: 'r1',
    status: 'pending',
    decidedById: null,
    decidedAt: null,
    reason: null,
    createdAt: NOW,
    ...overrides,
  };
}

const AGENTS: AgentListItem[] = [
  {
    id: 'a1',
    name: 'Claude Coder',
    runtimeId: 'r',
    provider: 'claude',
    canInvoke: true,
  },
  {
    id: 'a2',
    name: 'Private Bot',
    runtimeId: 'r',
    provider: 'codex',
    canInvoke: false,
  },
];

async function renderCard(proposals: ExecutorProposal[]) {
  const runtime = new I18nRuntime({
    defaultLocale: 'en-US',
    locales: ['en-US', 'zh-CN'],
    applicationNamespace: 'test-app',
  });
  runtime.registerApplicationNamespace('test-app', locales);
  await runtime.init('en-US');
  render(
    <I18nProvider runtime={runtime}>
      <QueryClientProvider client={new QueryClient()}>
        <ProposalsCard issueId='100' proposals={proposals} agents={AGENTS} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
});

describe('executor proposals card', () => {
  it('renders nothing when no proposal is pending', async () => {
    await renderCard([proposal({ status: 'accepted' })]);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('accepts and rejects one proposal on the issue that carries it', async () => {
    const user = userEvent.setup();
    api.request.mockResolvedValue({ data: {} });
    await renderCard([
      proposal({}),
      proposal({ id: 'p2', issueId: 's2', issueIdentifier: 'NP-12' }),
    ]);

    const card = screen.getByRole('region', { name: 'Executor proposals (2)' });
    expect(
      within(card).getAllByText('Planner suggests Claude Coder'),
    ).toHaveLength(2);

    await user.click(
      within(card).getByRole('button', {
        name: 'Accept the proposal for NP-11',
      }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/s1/proposals/p1/accept',
          method: 'POST',
        }),
      ),
    );
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Claude Coder is now the executor.' }),
      ),
    );

    await user.click(
      within(card).getByRole('button', {
        name: 'Reject the proposal for NP-12',
      }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/s2/proposals/p2/reject',
          method: 'POST',
        }),
      ),
    );
  });

  it('accepts all on the parent issue and reports skipped proposals', async () => {
    const user = userEvent.setup();
    api.request.mockResolvedValue({
      data: { accepted: [{}], skipped: [{ proposalId: 'p2' }] },
    });
    await renderCard([proposal({}), proposal({ id: 'p2', issueId: 's2' })]);

    await user.click(screen.getByRole('button', { name: /Accept all/ }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'np/issues/100/proposals/accept-all',
          method: 'POST',
        }),
      ),
    );
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          title:
            'Proposals accepted; 1 skipped because you cannot use the proposed agent.',
        }),
      ),
    );
  });

  it('disables accepting a proposal for an agent the viewer cannot invoke', async () => {
    await renderCard([
      proposal({ proposedAgentId: 'a2', proposedAgentName: 'Private Bot' }),
    ]);
    expect(
      screen.getByRole('button', { name: 'Accept the proposal for NP-11' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Reject the proposal for NP-11' }),
    ).toBeEnabled();
    // A single proposal needs no "Accept all".
    expect(screen.queryByRole('button', { name: /Accept all/ })).toBeNull();
  });
});
