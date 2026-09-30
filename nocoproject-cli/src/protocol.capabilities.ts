/** Configured permissions, independent of an agent's name or legacy kind. */
export const AGENT_CAPABILITIES = [
  'context.read',
  'workspace.read',
  'comment.create',
  'knowledge.propose',
  'issue.execute',
  'subtask.create',
  'dependency.write',
  'issue.status.write',
  'design.propose',
  'checklist.write',
  'workflow.propose',
  'pullRequest.link',
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];
export interface AgentConfiguration {
  readonly capabilities?: readonly AgentCapability[];
  readonly configurationRevision?: number;
}
export interface AgentEntryBinding {
  readonly agentId: string | null;
  readonly name: string;
  readonly instructions: string;
  readonly enabled: boolean;
}
export interface AgentEntryBindings {
  readonly revision: number;
  readonly conversation: AgentEntryBinding;
  readonly completion: AgentEntryBinding;
}
export interface ConfigurationSnapshot extends AgentConfiguration {
  readonly configurationFingerprint?: string;
  readonly instructions: string;
  readonly taskInstructions: string;
  readonly skillIds: readonly string[];
  readonly entryRevision: number;
}

export const AGENT_COMMANDS: Record<AgentCapability, readonly string[]> = {
  'context.read': [
    'issue get <issue> --json',
    'issue comment list <issue> --json',
    'issue attachment download <issue>',
    'kb list --json',
    'kb get <slug>',
    'workflow list --json',
  ],
  'workspace.read': [
    'pm projects --json',
    'pm issues --json',
    'pm issue <issue> --json',
    'pm inbox --json',
    'pm metrics --json',
    'pm knowledge --json',
  ],
  'comment.create': [
    'issue comment add <issue> --content-file ./reply.md [--parent <rootId>]',
  ],
  'knowledge.propose': [
    'kb propose --title <title> [--parent <slug|id>] --content-file ./kb.md --reason <reason>',
  ],
  'issue.execute': [
    'repo checkout <url> --json',
    'project get --json',
    'pr list [--issue <issue>] --json',
  ],
  'subtask.create': [
    'issue create --title <title> [--executor self|none|<agentId>] --json',
    'issue children <issue> --json',
  ],
  'dependency.write': [
    'issue dependency add|remove <issue> --blocked-by <issue>',
  ],
  'issue.status.write': ['issue status <issue> <statusKey>'],
  'design.propose': [
    'issue design-proposal <issue> --content-file ./proposal.md',
  ],
  'checklist.write': ['issue checklist <issue> check|uncheck <status>/<item>'],
  'workflow.propose': [
    'workflow propose <template> --definition-file ./workflow.json --reason <reason>',
  ],
  'pullRequest.link': ['pr link <url> [--issue <issue>] --json'],
};
