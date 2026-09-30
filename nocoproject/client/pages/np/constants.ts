import type {
  AgentListItem,
  InboxKind,
  IssueFilters,
  IssuePriority,
  LabelColor,
  RunStatus,
  StatusCatalogEntry,
  StatusCategory,
  UsageQuery,
  Workflow,
} from './types.js';
import type { MetricsQuery } from './types-iter3.js';

/**
 * The Phase 0 status catalog (protocol §1.1). The issue detail returns the authoritative catalog; this copy covers
 * the list page, whose endpoint does not return one, and the create form.
 */
export const DEFAULT_STATUS_CATALOG: readonly StatusCatalogEntry[] = [
  {
    key: 'backlog',
    category: 'unstarted',
    agentWritable: false,
    color: 'gray',
  },
  { key: 'todo', category: 'unstarted', agentWritable: false, color: 'blue' },
  // Iteration 4 §A: the design-first statuses, shown on the board only while an issue uses them.
  {
    key: 'analysis',
    category: 'started',
    agentWritable: true,
    color: 'blue',
  },
  {
    key: 'proposal_review',
    category: 'started',
    agentWritable: true,
    color: 'purple',
  },
  {
    key: 'in_progress',
    category: 'started',
    agentWritable: true,
    color: 'yellow',
  },
  {
    key: 'in_review',
    category: 'started',
    agentWritable: true,
    color: 'purple',
  },
  { key: 'blocked', category: 'started', agentWritable: true, color: 'red' },
  { key: 'done', category: 'done', agentWritable: false, color: 'green' },
  {
    key: 'cancelled',
    category: 'closed',
    agentWritable: false,
    color: 'gray',
  },
];

/** A status's color: the catalog's (from the workflow), else the built-in one, else by category. */
export function statusColor(
  statusKey: string,
  catalog: readonly StatusCatalogEntry[] = DEFAULT_STATUS_CATALOG,
): LabelColor {
  const entry =
    catalog.find((candidate) => candidate.key === statusKey) ??
    DEFAULT_STATUS_CATALOG.find((candidate) => candidate.key === statusKey);
  if (entry?.color) return entry.color;
  const fallback =
    DEFAULT_STATUS_CATALOG.find((candidate) => candidate.key === statusKey)
      ?.color ?? null;
  if (fallback) return fallback;
  const category = entry?.category ?? 'unstarted';
  return category === 'done'
    ? 'green'
    : category === 'started'
      ? 'yellow'
      : 'gray';
}

/**
 * The tone a status is drawn in (nocosolution/guidelines/frontend-standard.md §S7.1, `NpTag`): by meaning, not by the workflow's colour name, so
 * every workflow reads the same — not started grey, started blue, in review violet, blocked amber, done green,
 * cancelled slate. A custom started status the workflow marks purple reads as review, red / orange as blocked.
 */
export type StatusTone =
  'grey' | 'blue' | 'violet' | 'amber' | 'green' | 'slate';

export function statusTone(
  statusKey: string,
  catalog: readonly StatusCatalogEntry[] = DEFAULT_STATUS_CATALOG,
): StatusTone {
  const category = statusCategory(statusKey, catalog);
  if (category === 'done') return 'green';
  if (category === 'closed') return 'slate';
  if (category === 'unstarted') return 'grey';
  if (statusKey === 'in_review' || statusKey === 'proposal_review') {
    return 'violet';
  }
  if (statusKey === 'blocked') return 'amber';
  const color = catalog.find((entry) => entry.key === statusKey)?.color ?? null;
  if (color === 'purple') return 'violet';
  if (color === 'red' || color === 'orange') return 'amber';
  return 'blue';
}

/** Priority tones: urgent red, high orange, medium blue, low grey; no priority has no tag. */
export const PRIORITY_TONE: Readonly<
  Record<Exclude<IssuePriority, 'none'>, 'red' | 'orange' | 'blue' | 'grey'>
> = {
  urgent: 'red',
  high: 'orange',
  medium: 'blue',
  low: 'grey',
};

/** Locale keys under `np.status.*` are the status keys with the underscore removed (`in_progress` → `inProgress`). */
export function statusLabelKey(statusKey: string): string {
  return `np.status.${statusKey.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase())}`;
}

export const KNOWN_STATUS_KEYS: ReadonlySet<string> = new Set(
  DEFAULT_STATUS_CATALOG.map((entry) => entry.key),
);

export function statusCategory(
  statusKey: string,
  catalog: readonly StatusCatalogEntry[] = DEFAULT_STATUS_CATALOG,
): StatusCategory {
  return (
    catalog.find((entry) => entry.key === statusKey)?.category ??
    DEFAULT_STATUS_CATALOG.find((entry) => entry.key === statusKey)?.category ??
    'unstarted'
  );
}

export const ISSUE_PRIORITIES: readonly IssuePriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'queued',
  'deferred',
  'dispatched',
  'running',
]);

export const CANCELLABLE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'queued',
  'deferred',
  'dispatched',
  'running',
]);

export const RETRYABLE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'failed',
  'cancelled',
]);

export function isRuntimeOnline(agent: AgentListItem): boolean {
  if (typeof agent.runtimeOnline === 'boolean') return agent.runtimeOnline;
  return agent.runtimeStatus === 'online';
}

/** TanStack Query keys. Everything starts with `np` so a reconnect can invalidate the whole family. */
export const npKeys = {
  all: ['np'] as const,
  me: ['np', 'me'] as const,
  myPreferences: ['np', 'me', 'preferences'] as const,
  projects: ['np', 'projects'] as const,
  project: (id: string) => ['np', 'projects', id] as const,
  issues: ['np', 'issues'] as const,
  issueList: (filters: IssueFilters) =>
    ['np', 'issues', 'list', filters] as const,
  board: (filters: IssueFilters) => ['np', 'issues', 'board', filters] as const,
  issue: (id: string) => ['np', 'issue', id] as const,
  /** NP-78: under `issue(id)`, so the issue's realtime refresh refetches it. */
  issueAttachments: (id: string) => ['np', 'issue', id, 'attachments'] as const,
  agents: ['np', 'agents'] as const,
  runtimes: ['np', 'runtimes'] as const,
  computers: ['np', 'computers'] as const,
  run: (id: string) => ['np', 'run', id] as const,
  members: ['np', 'members'] as const,
  /** NP-88: pending invitations; under `members`, so a members refresh refetches them. */
  invitations: ['np', 'members', 'invitations'] as const,
  /** NP-153: business roles and who holds them; under `members`, so a members refresh refetches them. */
  accessRoles: ['np', 'members', 'roles'] as const,
  accessCatalog: ['np', 'access', 'catalog'] as const,
  labels: ['np', 'labels'] as const,
  workflows: ['np', 'workflows'] as const,
  inbox: ['np', 'inbox'] as const,
  inboxList: (kind: InboxKind, archived: boolean) =>
    ['np', 'inbox', 'list', kind, archived] as const,
  inboxUnread: ['np', 'inbox', 'unread'] as const,
  inboxPending: ['np', 'inbox', 'pending'] as const,
  /** The viewer's open decisions on one issue (the issue page's "Waiting for you" section). */
  issueDecisions: (issueId: string) =>
    ['np', 'inbox', 'issue', issueId] as const,
  // Phase 1 iteration 2
  gitConnection: ['np', 'integrations', 'github'] as const,
  approvals: ['np', 'approvals'] as const,
  intakeBatch: (id: string) => ['np', 'intake', id] as const,
  skills: ['np', 'skills'] as const,
  skill: (id: string) => ['np', 'skills', id] as const,
  agentEnv: (id: string) => ['np', 'agent-env', id] as const,
  agentEnvAudits: (id: string) => ['np', 'agent-env', id, 'audits'] as const,
  usage: (query: UsageQuery) => ['np', 'usage', query] as const,
  settings: ['np', 'settings'] as const,
  // Phase 1 iteration 3. Pages and columns sit under `issues`, activities under `issue(id)`, so the existing
  // realtime invalidations refetch every loaded page.
  issuePages: (filters: IssueFilters) =>
    ['np', 'issues', 'pages', filters] as const,
  boardV3: (filters: IssueFilters) =>
    ['np', 'issues', 'board-v3', filters] as const,
  boardColumn: (filters: IssueFilters, statusKey: string) =>
    ['np', 'issues', 'column', filters, statusKey] as const,
  issueSearch: (q: string) => ['np', 'issues', 'search', q] as const,
  issueActivities: (id: string, cursor: string | null) =>
    ['np', 'issue', id, 'activities', cursor] as const,
  knowledge: ['np', 'knowledge'] as const,
  knowledgeList: (filters: { projectId?: string; q?: string }) =>
    ['np', 'knowledge', 'list', filters] as const,
  knowledgeDoc: (id: string) => ['np', 'knowledge', 'doc', id] as const,
  knowledgeVersion: (id: string, version: number) =>
    ['np', 'knowledge', 'doc', id, 'version', version] as const,
  knowledgeProposals: ['np', 'knowledge', 'proposals'] as const,
  metrics: (query: MetricsQuery) => ['np', 'metrics', query] as const,
  workflow: (id: string) => ['np', 'workflows', id] as const,
  // Project manager 2.0 (NP-185). A plan sits under its conversation's issue, so the conversation's realtime refresh
  // refetches the cards in it.
  pm: ['np', 'pm'] as const,
  pmConversations: (filters: { q: string; archived: boolean }) =>
    ['np', 'pm', 'conversations', filters] as const,
  pmConversation: (id: string) => ['np', 'pm', 'conversation', id] as const,
  pmAgentChoice: ['np', 'pm', 'agent-choice'] as const,
  pmPlans: (issueId: string) => ['np', 'issue', issueId, 'plans'] as const,
};

/** Dormant statuses (§ terminology): backlog, or any status whose category is done or closed. */
export function isDormantStatus(
  statusKey: string,
  catalog: readonly StatusCatalogEntry[] = DEFAULT_STATUS_CATALOG,
): boolean {
  if (statusKey === 'backlog') return true;
  const category = statusCategory(statusKey, catalog);
  return category === 'done' || category === 'closed';
}

export function isTerminalStatus(
  statusKey: string,
  catalog: readonly StatusCatalogEntry[] = DEFAULT_STATUS_CATALOG,
): boolean {
  const category = statusCategory(statusKey, catalog);
  return category === 'done' || category === 'closed';
}

/**
 * A workflow's statuses as a catalog. `agentWritable` is not part of the workflow definition (the transitions say
 * who may move where), so it is carried over from the built-in catalog and defaults to false.
 */
export function catalogFromWorkflow(
  workflow: Workflow | null | undefined,
): readonly StatusCatalogEntry[] {
  const statuses = workflow?.definition.statuses;
  if (!statuses || statuses.length === 0) return DEFAULT_STATUS_CATALOG;
  return statuses.map((status) => ({
    key: status.key,
    category: status.category,
    color: status.color,
    agentWritable:
      DEFAULT_STATUS_CATALOG.find((entry) => entry.key === status.key)
        ?.agentWritable ?? false,
  }));
}

export const LABEL_COLORS: readonly LabelColor[] = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
];

/**
 * Label colour names mapped onto the tag hues (nocosolution/guidelines/frontend-standard.md §S7.2), so a label's dot and chip match the
 * status and priority tags in light and dark. The name beside the dot carries the meaning; the colour helps scanning.
 */
export const LABEL_TONE: Readonly<
  Record<
    LabelColor,
    'grey' | 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'violet'
  >
> = {
  gray: 'grey',
  red: 'red',
  orange: 'orange',
  yellow: 'amber',
  green: 'green',
  blue: 'blue',
  purple: 'violet',
};

export const LABEL_DOT_CLASS: Readonly<Record<LabelColor, string>> = {
  gray: 'bg-np-ink-grey',
  red: 'bg-np-ink-red',
  orange: 'bg-np-ink-orange',
  yellow: 'bg-np-ink-amber',
  green: 'bg-np-ink-green',
  blue: 'bg-np-ink-blue',
  purple: 'bg-np-ink-violet',
};

/**
 * Version of the daemon/CLI this application ships. Every `pnpm build` packs `nocoproject-cli` into
 * `dist/client/assets/cli/nocoproject-cli-<version>.tgz` (`scripts/pack-cli.sh`, a build hook in `cli/plugins.ts`) and
 * fails when this does not match its package.json; bump both together.
 */
export const CLI_VERSION = '0.5.3';

/** How to install the daemon/CLI on another computer: npm fetches the tarball this application serves. */
export function cliInstallCommand(serverUrl: string): string {
  return `npm i -g ${serverUrl}/assets/cli/nocoproject-cli-${CLI_VERSION}.tgz`;
}
