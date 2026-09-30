import type { AgentEntryBindings } from '../agent-capabilities.js';
import { readDefaultProcess } from '../api-iter4.js';
import type { AgentListItem, WorkspaceSettings } from '../types.js';
import type {
  DefaultProcess,
  WorkspaceSettingsPhase1Iter4,
} from '../types-iter4.js';

/** Settings → General, iteration 4 (§A, §C): the fields as the form edits them. */
export interface PmSettingsDraft {
  readonly agentEntries: AgentEntryBindings;
  readonly defaultProcess: DefaultProcess;
  readonly pmAgentId: string | null;
  readonly retrospectiveOnDone: boolean;
}

/** The iteration 4 settings as the form edits them; missing values read as the contract's defaults. */
export function pmSettingsDraft(settings: WorkspaceSettings): PmSettingsDraft {
  return {
    agentEntries: settings.agentEntries ?? {
      revision: 1,
      conversation: {
        agentId: null,
        name: 'Assistant',
        instructions: '',
        enabled: true,
      },
      completion: {
        agentId: null,
        name: 'Completion',
        instructions: '',
        enabled: false,
      },
    },
    defaultProcess: readDefaultProcess(settings.defaultProcess),
    pmAgentId:
      typeof settings.pmAgentId === 'string' && settings.pmAgentId
        ? settings.pmAgentId
        : null,
    retrospectiveOnDone: settings.retrospectiveOnDone !== false,
  };
}

export function pmSettingsInput(draft: PmSettingsDraft): Pick<
  WorkspaceSettingsPhase1Iter4,
  'defaultProcess'
> & {
  agentEntries: AgentEntryBindings;
} {
  return {
    defaultProcess: draft.defaultProcess,
    agentEntries: draft.agentEntries,
  };
}

export type EntryKey = 'conversation' | 'completion';

/** The agents an entry may name (mirrors `validateEntries` in the server's `agent-entries.ts`). */
export function entryAgentEligible(
  key: EntryKey,
  agent: AgentListItem,
): boolean {
  if (!agent.canInvoke || agent.archivedAt) return false;
  if (key === 'conversation') return agent.kind === 'manager';
  return (
    agent.kind !== 'manager' &&
    agent.capabilities?.includes('comment.create') === true
  );
}

/** Why the saved agent no longer fits its entry; null when it does (or nothing is chosen). */
export function entryAgentProblem(
  key: EntryKey,
  agentId: string | null,
  agents: readonly AgentListItem[],
): 'notManager' | 'managerCompletion' | 'unavailable' | null {
  if (!agentId) return null;
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) return 'unavailable';
  if (key === 'conversation' && agent.kind !== 'manager') return 'notManager';
  if (key === 'completion' && agent.kind === 'manager')
    return 'managerCompletion';
  return entryAgentEligible(key, agent) ? null : 'unavailable';
}
