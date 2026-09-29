import type { AgentEntryBindings } from '../shared/protocol.capabilities.js';
import type { Conn } from '../shared/db.js';
import { conflict, invalid } from '../shared/errors.js';
import { hasCapability } from '../agent/capabilities.js';
import { canInvokeAgent, loadAgentAccess } from '../shared/authz.js';
export const EMPTY_ENTRIES: AgentEntryBindings = {
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
};
export async function validateEntries(
  conn: Conn,
  value: AgentEntryBindings,
  current: AgentEntryBindings,
  userId: string,
): Promise<AgentEntryBindings> {
  if (value?.revision !== current.revision)
    throw conflict('CONFIGURATION_CONFLICT', 'Reload entry settings.');
  for (const entry of [value.conversation, value.completion]) {
    if (
      !entry ||
      typeof entry.enabled !== 'boolean' ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      entry.name.length > 100 ||
      typeof entry.instructions !== 'string' ||
      entry.instructions.length > 50000
    )
      throw invalid('INVALID_ENTRY', 'Invalid entry configuration.');
    if (entry.agentId !== null) {
      const agent = await loadAgentAccess(conn, entry.agentId);
      if (
        !agent ||
        !(await canInvokeAgent(conn, userId, agent)) ||
        !(await hasCapability(conn, entry.agentId, 'comment.create'))
      )
        throw invalid(
          'INVALID_ENTRY_AGENT',
          'Choose an accessible agent with comment.create.',
        );
    }
  }
  return { ...value, revision: current.revision + 1 };
}
