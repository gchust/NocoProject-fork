import type { WorkspaceSettings } from '../types.js';

/** The query key of the viewer's project manager conversation (iteration 4 §C). */
export const pmConversationKey = ['np', 'pm', 'conversation'] as const;

/**
 * Whether the settings say there is no project manager: `pmAgentId` present and empty. A server without the field
 * (or a viewer who may not read settings) leaves the answer to the conversation endpoint.
 */
export function pmNotConfigured(settings: WorkspaceSettings): boolean {
  return 'pmAgentId' in settings && !settings.pmAgentId;
}
