import { useTranslation } from '@nocobase/i18n/client';
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
  hints: { readonly online: string; readonly offline: string },
): NpMentionCandidate[] {
  return [
    ...agents
      .filter((agent) => !agent.archivedAt)
      .map((agent): NpMentionCandidate => ({
        kind: 'agent',
        id: agent.id,
        name: agent.name,
        hint: isRuntimeOnline(agent) ? hints.online : hints.offline,
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
  const { t } = useTranslation();
  const online = t('np.common.online');
  const offline = t('np.common.offline');
  return useMemo(
    () => mentionCandidates(agents, members, { online, offline }),
    [agents, members, online, offline],
  );
}
