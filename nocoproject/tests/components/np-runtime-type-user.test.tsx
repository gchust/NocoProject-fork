import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, expect, it } from 'vitest';

import { NpExecutorSelect } from '../../client/components/np-executor-select.js';
import { ExecutionLog } from '../../client/pages/np/issues/detail/execution-log.js';
import { PmAgentNotice } from '../../client/pages/np/pm/conversation/pm-agent-status.js';
import type { AgentListItem, RunSummary } from '../../client/pages/np/types.js';
import type { PmConversationAgent } from '../../client/pages/np/types-pm.js';
import { renderNp } from './np-harness.js';

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => ({ request: vi.fn() }),
}));
vi.mock('@nocobase/app-plugin-authorization/client', () => ({
  useCan: () => ({ can: false }),
}));

const NOW = new Date().toISOString();

function agent(
  id: string,
  name: string,
  extra: Partial<AgentListItem> = {},
): AgentListItem {
  return {
    id,
    name,
    kind: 'coder',
    canInvoke: true,
    runtimeOnline: true,
    capabilities: ['issue.execute'],
    ...extra,
  } as unknown as AgentListItem;
}

describe('agent types for business users (NP-223)', () => {
  it('groups the executor options by type and says why an agent cannot be chosen', async () => {
    const user = userEvent.setup();
    await renderNp(
      <NpExecutorSelect
        aria-label='executor'
        value={{ type: 'none', id: null }}
        agents={[
          agent('1', 'Coder'),
          agent('2', 'Offline coder', { runtimeOnline: false }),
          agent('3', 'Answerer', {
            runtimeType: 'builtin',
            capabilities: ['context.read'],
          }),
          agent('4', 'Lead', { kind: 'manager', capabilities: [] }),
        ]}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'executor' }));

    expect(await screen.findByText('Computer agent')).toBeVisible();
    expect(screen.getByText('Built-in agent')).toBeVisible();
    expect(screen.queryByText('Lead')).toBeNull();
    const builtin = screen.getByRole('option', { name: /Answerer/u });
    expect(builtin).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(builtin).getByText('This agent cannot change code'),
    ).toBeVisible();
    expect(
      within(builtin).getByRole('img', { name: 'Built-in agent' }),
    ).toBeVisible();
    expect(screen.getByRole('option', { name: /^Coder/u })).toBeVisible();
    expect(screen.queryByText(/technical|mismatch/iu)).toBeNull();
  });

  it('tags each run and filters the log only when both types ran', async () => {
    const user = userEvent.setup();
    const run = (id: string, runtimeType?: 'builtin'): RunSummary =>
      ({
        id,
        agentId: id,
        agentName: `Agent ${id}`,
        status: 'completed',
        createdAt: NOW,
        ...(runtimeType ? { runtimeType } : {}),
      }) as RunSummary;
    const first = await renderNp(
      <ExecutionLog runs={[run('a')]} agents={[]} issueId='1' />,
    );
    expect(screen.queryByTestId('np-runs-type-filter')).toBeNull();
    first.unmount();

    await renderNp(
      <ExecutionLog
        runs={[run('a'), run('b', 'builtin')]}
        agents={[]}
        issueId='1'
      />,
    );
    expect(screen.getByText('Agent a')).toBeVisible();
    await user.click(screen.getByTestId('np-runs-type-filter'));
    await user.click(
      await screen.findByRole('option', { name: 'Built-in agent' }),
    );
    expect(screen.queryByText('Agent a')).toBeNull();
    expect(screen.getByText('Agent b')).toBeVisible();
  });

  it('names the unavailable model service for a built-in project manager', async () => {
    const builtin = {
      id: 'p1',
      name: 'Answerer',
      source: 'system',
      online: false,
      runtimeName: 'DeepSeek',
      compat: 'ok',
      personalAvailable: false,
      runtimeType: 'builtin',
      statusReason: 'check_failed',
    } as PmConversationAgent;
    await renderNp(
      <PmAgentNotice
        agent={builtin}
        notConfigured={false}
        busy={false}
        onFallback={() => {}}
        onRestore={() => {}}
      />,
    );
    expect(
      screen.getByText('Model service unavailable: Connection check failed'),
    ).toBeVisible();
    expect(screen.queryByText(/offline/iu)).toBeNull();
  });
});
