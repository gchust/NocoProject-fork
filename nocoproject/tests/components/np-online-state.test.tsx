import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NpOnlineState } from '../../client/components/np-badges.js';
import { mentionCandidates } from '../../client/pages/np/issues/detail/mention-candidates.js';
import type { AgentListItem } from '../../client/pages/np/types.js';
import { renderNp } from './np-harness.js';

// NP-165: online and offline differ in tone, dot fill and word, so they read apart at a glance.
describe('NpOnlineState', () => {
  it('shows online as a green tag with a solid dot', async () => {
    await renderNp(<NpOnlineState online />);
    const tag = screen.getByText(/online|在线/i).closest('[data-slot=np-tag]');
    expect(tag).toHaveAttribute('data-tone', 'green');
    expect(tag).toHaveAttribute('data-online', 'true');
    expect(tag?.querySelector('[aria-hidden=true]')).toHaveClass('bg-current');
  });

  it('shows offline as a grey tag with a hollow dot', async () => {
    await renderNp(<NpOnlineState online={false} />);
    const tag = screen.getByText(/offline|离线/i).closest('[data-slot=np-tag]');
    expect(tag).toHaveAttribute('data-tone', 'grey');
    expect(tag).toHaveAttribute('data-online', 'false');
    const dot = tag?.querySelector('[aria-hidden=true]');
    expect(dot).toHaveClass('border');
    expect(dot).not.toHaveClass('bg-current');
  });
});

describe('mentionCandidates', () => {
  it('carries each agent runtime state and none for members', () => {
    const agents = [
      { id: '1', name: 'A', runtimeOnline: true },
      { id: '2', name: 'B', runtimeStatus: 'offline' },
    ] as unknown as AgentListItem[];
    const candidates = mentionCandidates(agents, [
      { userId: '9', name: 'M' } as never,
    ]);
    expect(candidates.map((candidate) => candidate.online)).toEqual([
      true,
      false,
      undefined,
    ]);
  });
});
