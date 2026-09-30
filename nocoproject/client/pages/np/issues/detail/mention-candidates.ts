import { useMemo } from 'react';

import type { NpMentionCandidate } from '@/components/np-rich-text-editor';

import { isRuntimeOnline } from '../../constants.js';
import type { AgentListItem, Member } from '../../types.js';

/**
 * Who the `@` list offers: agents first (a mention triggers them), then members. Archived agents are left out; an
 * agent's online state is shown beside its name.
 */
export function mentionCandidates(
  agents: readonly AgentListItem[],
  members: readonly Member[] | undefined,
): NpMentionCandidate[] {
  return [
    ...agents
      .filter((agent) => !agent.archivedAt)
      .map((agent): NpMentionCandidate => ({
        kind: 'agent',
        id: agent.id,
        name: agent.name,
        online: isRuntimeOnline(agent),
      })),
    ...(members ?? []).map((member): NpMentionCandidate => ({
      kind: 'user',
      id: member.userId,
      name: member.name,
    })),
  ];
}

export function useMentionCandidates(
  agents: readonly AgentListItem[],
  members: readonly Member[] | undefined,
): NpMentionCandidate[] {
  return useMemo(() => mentionCandidates(agents, members), [agents, members]);
}
