import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NpActorAvatar } from '../../client/components/np-actor-avatar.js';
import { NpExecutor } from '../../client/components/np-badges.js';
import { NpExecutorSelect } from '../../client/components/np-executor-select.js';
import type { AgentListItem } from '../../client/pages/np/types.js';
import { renderNp } from './np-harness.js';

const LONG = 'Zhou-Claude-Sonnet-mac-with-a-very-long-name';

// NP-143: a long person or agent name truncates to the space it is given and keeps the full name on hover.
describe('long actor names', () => {
  it('NpExecutor keeps the full name as its title and truncates only the name', async () => {
    await renderNp(<NpExecutor type='agent' name={LONG} activeRunCount={0} />);
    const name = screen.getByText(LONG);
    expect(name).toHaveClass('truncate');
    const root = name.parentElement!;
    expect(root).toHaveAttribute('title', LONG);
    expect(root).toHaveClass('max-w-full', 'min-w-0');
  });

  it('NpActorAvatar with a name bounds itself and titles the name', async () => {
    await renderNp(<NpActorAvatar type='user' name={LONG} showName />);
    const name = screen.getByText(LONG);
    expect(name).toHaveAttribute('title', LONG);
    expect(name.parentElement).toHaveClass('max-w-full', 'min-w-0');
  });

  it('NpExecutorSelect titles the trigger with the chosen name', async () => {
    const agent = {
      id: '1',
      name: LONG,
      kind: 'executor',
      canInvoke: true,
    } as unknown as AgentListItem;
    await renderNp(
      <NpExecutorSelect
        aria-label='executor'
        value={{ type: 'agent', id: '1' }}
        agents={[agent]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'executor' })).toHaveAttribute(
      'title',
      LONG,
    );
  });
});
