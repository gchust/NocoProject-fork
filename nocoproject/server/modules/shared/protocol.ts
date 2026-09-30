/**
 * NocoProject protocol types (Phase 0 protocol 1; the version history is in protocol.daemon-compat.ts).
 *
 * This is the shared contract between the server, the daemon / CLI, and the frontend. The daemon
 * package keeps an identical copy (nocoproject-cli/src/protocol.ts); a change here must be
 * mirrored there, and docs/phase0/protocol.md updated.
 */

import type { RuntimeDaemonInfo } from './protocol.daemon-compat.js';

/** The protocol a daemon of this release speaks (NP-150: 2). What the server accepts is `SUPPORTED_PROTOCOLS`. */
export const PROTOCOL_VERSION = 2 as const;

// ---------- Status catalog ----------

export type StatusCategory = 'unstarted' | 'started' | 'done' | 'closed';

export type BuiltInStatusKey =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface StatusCatalogEntry {
  readonly key: string;
  readonly category: StatusCategory;
  readonly agentWritable: boolean;
}

export interface StatusTransition {
  readonly from: string;
  readonly to: string;
}

export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export type ExecutorType = 'user' | 'agent' | 'none';

export type ActorType = 'user' | 'agent' | 'system';

// ---------- Runs ----------

export type RunStatus =
  | 'queued'
  | 'deferred'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PlatformFailureReason =
  | 'runtimeOffline'
  | 'queuedExpired'
  | 'runtimeRecovery'
  | 'environmentPrepareFailed'
  | 'cancelled'
  | 'timeout'
  | 'agentBlocked'
  | 'apiInvalidRequest';

export type AgentFailureReason =
  | 'agentError.providerAuth'
  | 'agentError.providerQuota'
  | 'agentError.providerRateLimit'
  | 'agentError.providerServerError'
  | 'agentError.providerNetwork'
  | 'agentError.modelUnavailable'
  | 'agentError.contextOverflow'
  | 'agentError.missingConfig'
  | 'agentError.missingExecutable'
  | 'agentError.versionUnsupported'
  | 'agentError.processFailure'
  | 'agentError.emptyOutput'
  | 'agentError.agentTimeout'
  | 'agentError.unknown';

export type FailureReason = PlatformFailureReason | AgentFailureReason;

export const RETRYABLE_FAILURE_REASONS: readonly FailureReason[] = [
  'runtimeOffline',
  'runtimeRecovery',
  'timeout',
  'agentError.providerNetwork',
];

export const SESSION_POISONING_FAILURE_REASONS: readonly FailureReason[] = [
  'agentError.contextOverflow',
  'apiInvalidRequest',
];

export type RunTriggerType =
  'assign' | 'statusChange' | 'mention' | 'reply' | 'comment' | 'retry';

export type RunEventType =
  'text' | 'thinking' | 'toolUse' | 'toolResult' | 'status' | 'error';

export interface RunEventInput {
  readonly seq: number;
  readonly type: RunEventType;
  readonly tool?: string;
  readonly content?: string;
  readonly input?: unknown;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly at: string;
}

export interface RunUsageInput {
  readonly provider: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

// ---------- Daemon interface ----------

export type AgentProvider = 'claude' | 'opencode' | 'codex' | 'echo';

export interface RuntimeCapabilities {
  readonly resume: boolean;
  readonly steering: boolean;
}

export interface DaemonRegisterRequest {
  readonly daemonId: string;
  readonly deviceName: string;
  readonly version: string;
  readonly protocolVersion: number;
  readonly runtimes: readonly {
    readonly provider: AgentProvider;
    readonly version: string;
    readonly capabilities: RuntimeCapabilities;
  }[];
}

export interface DaemonRegisterResponse {
  readonly runtimes: readonly {
    readonly id: string;
    readonly provider: AgentProvider;
  }[];
  readonly serverTime: string;
  readonly protocolVersion: number;
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
}

export interface DaemonHeartbeatRequest {
  readonly daemonId: string;
  readonly runtimeIds: readonly string[];
}

export interface DaemonClaimRequest {
  readonly configurationProtocol?: number;
  readonly daemonId: string;
  readonly slots: readonly {
    readonly runtimeId: string;
    readonly free: number;
  }[];
}

export interface ClaimedTriggerComment {
  readonly id: string;
  readonly authorName: string;
  readonly content: string;
  readonly parentId: string | null;
  readonly rootId: string;
}

export interface ClaimedRun {
  readonly run: {
    readonly id: string;
    readonly agentId: string;
    readonly runtimeId: string;
    readonly attempt: number;
    readonly priority: number;
    readonly createdAt: string;
  };
  readonly token: string;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly capabilities?: readonly import('./protocol.capabilities.js').AgentCapability[];
    readonly configurationRevision?: number;
    readonly instructions: string;
    readonly provider: AgentProvider;
    readonly model: string | null;
  };
  readonly issue: {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly statusKey: string;
    readonly ownerName: string;
  };
  readonly statusCatalog: readonly StatusCatalogEntry[];
  readonly agentTransitions: readonly StatusTransition[];
  readonly triggers: readonly {
    readonly type: RunTriggerType;
    readonly comment?: ClaimedTriggerComment;
  }[];
  readonly session: {
    readonly providerSessionId: string | null;
    readonly workDir: string | null;
    readonly fresh: boolean;
  };
  readonly server: { readonly url: string; readonly protocolVersion: number };
  readonly leaseSeconds: number;
}

export interface DaemonClaimResponse {
  readonly runs: readonly ClaimedRun[];
}

export interface DaemonStartRequest {
  /** Opt in to durable comments and same-run continuation. */
  readonly acceptsInput?: boolean;
  readonly providerSessionId?: string;
  readonly workDir: string;
}

export interface DaemonEventsRequest {
  readonly events: readonly RunEventInput[];
}

export interface DaemonRunStatusResponse {
  readonly inputs?: readonly ClaimedTriggerComment[];
  readonly status: RunStatus;
  readonly cancelRequested: boolean;
}

export interface DaemonCompleteRequest {
  /** Successfully processed input comment IDs; completion is fenced against new input. */
  readonly handledInputIds?: readonly string[];
  readonly providerSessionId?: string;
  readonly workDir: string;
  readonly summary?: string;
  readonly usage?: RunUsageInput;
}

export interface DaemonFailRequest {
  readonly reason: FailureReason;
  readonly detail?: string;
  readonly providerSessionId?: string;
  readonly workDir?: string;
  readonly sessionPoisoned?: boolean;
}

/** Payload on the per-user topic `np:daemon` that the daemon subscribes to */
export type DaemonWakeupPayload =
  | { readonly kind: 'workAvailable'; readonly runtimeId: string }
  | { readonly kind: 'cancelRequested'; readonly runId: string };

// ---------- Agent write-back interface ----------

export interface IssueForAgent {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly statusKey: string;
  readonly priority: IssuePriority;
  readonly ownerName: string;
  readonly executor: {
    readonly type: ExecutorType;
    readonly id: string | null;
    readonly name: string | null;
  };
}

export interface CommentForAgent {
  readonly id: string;
  readonly authorType: ActorType;
  readonly authorName: string;
  readonly content: string;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly createdAt: string;
}

export interface AgentContextResponse {
  readonly run: { readonly id: string };
  readonly agent: { readonly id: string; readonly name: string };
  readonly issue: IssueForAgent;
  readonly statusCatalog: readonly StatusCatalogEntry[];
  readonly agentTransitions: readonly StatusTransition[];
  /** Phase 1 iteration 1: the project and repo resources of the run's issue (server always returns this; null when there is no project) */
  readonly project?: ClaimedProject | null;
}

// ---------- Browser realtime topics ----------

export const REALTIME_TOPICS = {
  issues: 'np:issues',
  agents: 'np:agents',
  daemon: 'np:daemon',
  run: (runId: string): string => `np:run:${runId}`,
} as const;

export type IssuesTopicPayload = {
  readonly kind: 'issue.changed';
  readonly issueId: string;
};
export type AgentsTopicPayload = { readonly kind: 'agents.changed' };
export type RunTopicPayload =
  | { readonly kind: 'run.events'; readonly last: number }
  | { readonly kind: 'run.status'; readonly status: RunStatus };

// ---------- Run token ----------

export const RUN_TOKEN_PREFIX = 'npr_' as const;
export const RUN_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const CLAIM_LEASE_SECONDS = 45;
export const RUNTIME_OFFLINE_AFTER_SECONDS = 150;
export const DISPATCHED_TIMEOUT_SECONDS = 300;
export const RUNTIME_RECONNECT_GRACE_SECONDS = 3 * 60 * 60;

/** The CLI automatically works in run-token mode when these environment variables are present */
export const RUN_ENV = {
  serverUrl: 'NOCOPROJECT_SERVER_URL',
  token: 'NOCOPROJECT_TOKEN',
  runId: 'NOCOPROJECT_RUN_ID',
  agentId: 'NOCOPROJECT_AGENT_ID',
  issueId: 'NOCOPROJECT_ISSUE_ID',
  issueKey: 'NOCOPROJECT_ISSUE_KEY',
} as const;

// ---------- UI interface (browser, protocol.md §3) ----------
//
// Response shapes added during the server's Phase 0 implementation (additive only). The daemon does not use these types.

export type AgentAccess = 'ownerOnly' | 'everyone';
export type RuntimeKind = 'personal' | 'server';
export type RuntimeVisibility = 'private' | 'public';
/** `upgrade_required` (NP-150): the daemon is alive but must be upgraded before it may claim runs. */
export type RuntimeStatus = 'online' | 'offline' | 'upgrade_required';
export type CommentKind = 'comment' | 'system';

/** Failure response body: `{ code, message }` with the corresponding HTTP status code */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  /** Machine-readable extras for some codes (e.g. `PR_NOT_MERGEABLE` → `{ blocker }`) */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface MeResponse {
  readonly userId: string;
  readonly name: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExecutorInput {
  readonly type: ExecutorType;
  readonly id?: string | null;
}

export interface Issue {
  readonly id: string;
  readonly number: number;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly statusKey: string;
  readonly priority: IssuePriority;
  readonly ownerUserId: string | null;
  readonly executorType: ExecutorType;
  readonly executorId: string | null;
  readonly parentIssueId: string | null;
  readonly projectId: string | null;
  readonly revision: number;
  readonly lastActivityAt: string;
  readonly createdById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueListItem extends Issue {
  readonly ownerName: string | null;
  readonly executorName: string | null;
  /** Count of runs in dispatched | running */
  readonly activeRunCount: number;
}

export interface Comment {
  readonly id: string;
  readonly issueId: string;
  readonly authorType: ActorType;
  readonly authorId: string | null;
  readonly authorName: string;
  readonly content: string;
  readonly kind: CommentKind;
  readonly parentId: string | null;
  /** The thread's root comment id (a top-level comment's own id) */
  readonly rootId: string;
  readonly sourceRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** @temporary(nocobase-official): to be replaced by NocoBase's official activity feed and change events */
export interface Activity {
  readonly id: string;
  readonly issueId: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly action: string;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
}

export interface RunSummary {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  /** Type of the first trigger */
  readonly triggerType: RunTriggerType | null;
  readonly status: RunStatus;
  readonly attempt: number;
  readonly threadScope: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Phase 1: the agent's working branch (reported by the daemon); null when there was no checkout */
  readonly branchName: string | null;
  readonly repoUrl: string | null;
}

export interface IssueDetail {
  readonly issue: IssueListItem;
  /** Flat list ordered by createdAt ascending; threads are organized via parentId / rootId */
  readonly comments: readonly Comment[];
  readonly activities: readonly Activity[];
  readonly runs: readonly RunSummary[];
  readonly statusCatalog: readonly StatusCatalogEntry[];
}

export interface CreateIssueRequest {
  readonly title: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  readonly projectId?: string | null;
  /** Defaults to the current user */
  readonly ownerUserId?: string | null;
  readonly executor?: ExecutorInput;
  /** Defaults to todo (an optional field added by the server implementation) */
  readonly statusKey?: string;
}

export interface UpdateIssueRequest {
  readonly title?: string;
  readonly description?: string;
  readonly statusKey?: string;
  readonly priority?: IssuePriority;
  readonly ownerUserId?: string | null;
  readonly executor?: ExecutorInput;
  readonly revision: number;
}

export interface CreateCommentRequest {
  readonly content: string;
  readonly parentId?: string | null;
}

export interface TriggeredRun {
  readonly agentId: string;
  readonly runId: string;
}

export interface CreateCommentResponse {
  readonly comment: Comment;
  readonly triggered: readonly TriggeredRun[];
}

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerUserId: string;
  readonly instructions: string;
  readonly runtimeId: string | null;
  readonly provider: AgentProvider;
  readonly model: string | null;
  readonly maxConcurrentRuns: number;
  readonly access: AgentAccess;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentListItem extends Agent {
  readonly runtimeName: string | null;
  readonly runtimeOnline: boolean;
  /** Count of runs in dispatched | running */
  readonly activeRunCount: number;
}

export interface CreateAgentRequest {
  readonly name: string;
  readonly description?: string | null;
  readonly instructions: string;
  readonly runtimeId: string;
  readonly provider: AgentProvider;
  readonly model?: string | null;
  readonly maxConcurrentRuns?: number;
  readonly access?: AgentAccess;
}

export interface UpdateAgentRequest {
  readonly name?: string;
  readonly description?: string | null;
  readonly instructions?: string;
  readonly runtimeId?: string;
  readonly provider?: AgentProvider;
  readonly model?: string | null;
  readonly maxConcurrentRuns?: number;
  readonly access?: AgentAccess;
  /** true archives it, false unarchives it */
  readonly archived?: boolean;
}

export interface Runtime {
  readonly id: string;
  readonly daemonId: string;
  readonly provider: AgentProvider;
  readonly name: string;
  readonly kind: RuntimeKind;
  readonly ownerUserId: string;
  readonly ownerName: string | null;
  readonly visibility: RuntimeVisibility;
  readonly status: RuntimeStatus;
  /** status === 'online' and lastSeenAt is within the last 150 seconds */
  readonly online: boolean;
  readonly lastSeenAt: string | null;
  readonly version: string | null;
  readonly capabilities: RuntimeCapabilities | null;
  readonly deviceInfo: Readonly<Record<string, unknown>> | null;
  /** NP-150: the daemon's CLI version and compatibility; null for rows registered before it recorded them. */
  readonly daemon?: RuntimeDaemonInfo | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Run {
  readonly id: string;
  readonly agentId: string;
  readonly runtimeId: string | null;
  readonly kind: 'issue';
  readonly status: RunStatus;
  readonly priority: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryOfRunId: string | null;
  readonly subjectType: 'issue';
  readonly subjectId: string;
  readonly threadScope: string | null;
  readonly actorUserId: string | null;
  readonly ownerUserId: string | null;
  readonly fireAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly dispatchedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly failureReason: FailureReason | null;
  readonly failureDetail: string | null;
  readonly cancelRequestedAt: string | null;
  readonly cancelledById: string | null;
  readonly resultSummary: string | null;
  readonly providerSessionId: string | null;
  readonly workDir: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunTriggerItem {
  readonly id: string;
  readonly type: RunTriggerType;
  readonly commentId: string | null;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly createdById: string | null;
  readonly createdAt: string;
}

export interface RunDetail extends Run {
  readonly configurationSnapshot?:
    import('./protocol.capabilities.js').ConfigurationSnapshot | null;
  readonly agentName: string;
  readonly triggers: readonly RunTriggerItem[];
  readonly usage: readonly RunUsageInput[];
}

export interface RunEvent {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly type: RunEventType;
  readonly tool: string | null;
  readonly content: string | null;
  readonly input: unknown;
  readonly output: string | null;
  readonly truncated: boolean;
  readonly at: string;
}

/** Full response body of GET /np/runs/:id/events (`last` is a sibling of `data`) */
export interface RunEventsResponse {
  readonly data: readonly RunEvent[];
  readonly last: number;
}

/** Response of POST /np/daemon/runs/:id/events */
export interface DaemonEventsResponse {
  readonly accepted: number;
  readonly last: number;
}

/** Max events per batch and max body size per event (exceeding it truncates and sets truncated=true) */
export const RUN_EVENTS_MAX_BATCH = 200;
export const RUN_EVENT_MAX_CONTENT_BYTES = 64 * 1024;

// ---------- Phase 1 iteration 1 (docs/phase1/iteration-1-contract.md) ----------
//
// Additive only. The daemon's copy nocoproject-cli/src/protocol.ts must be kept in sync.

export type MemberRole = 'owner' | 'admin' | 'member';
export type ProjectVisibility = 'everyone' | 'members';
export type ProjectStatus =
  'planned' | 'in_progress' | 'paused' | 'completed' | 'cancelled';
export type ProjectMemberRole = 'lead' | 'member';
export type LabelColor =
  'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export type DependencyType = 'blockedBy' | 'relatedTo';
export type ProposalStatus =
  'pending' | 'accepted' | 'rejected' | 'autoAccepted';
export type SubscriptionReason =
  'creator' | 'owner' | 'executor' | 'commenter' | 'mentioned' | 'manual';
export type InboxKind = 'decision' | 'info';
export type InboxItemType =
  | 'review_requested'
  | 'agent_blocked'
  | 'proposal_pending'
  | 'batch_done'
  | 'dependency_released'
  | 'run_failed'
  | 'owner_assigned'
  | 'executor_assigned'
  | 'mentioned'
  | 'commented'
  | 'status_changed';
export type AgentAccessLevel = 'ownerOnly' | 'specificUsers' | 'everyone';
export type TransitionActor = 'user' | 'agent' | 'system';

/** Trigger types added in iteration 1; used merged with RunTriggerType */
export type Phase1RunTriggerType =
  RunTriggerType | 'dependencyReleased' | 'childBatchDone' | 'proposalAccepted';

export interface WorkflowStatusDefinition {
  readonly key: string;
  readonly name: string;
  readonly category: StatusCategory;
  readonly color: LabelColor;
  readonly builtIn: boolean;
}

export interface WorkflowTransitionDefinition {
  /** '*' means any */
  readonly from: string;
  readonly to: string;
  readonly actors: readonly TransitionActor[];
}

export interface WorkflowDefinition {
  readonly statuses: readonly WorkflowStatusDefinition[];
  readonly transitions: readonly WorkflowTransitionDefinition[];
  readonly childBatchDoneWakesParentExecutor: boolean;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly definition: WorkflowDefinition;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Label {
  readonly id: string;
  readonly name: string;
  readonly color: LabelColor;
}

export interface IssueDependency {
  readonly dependencyId: string;
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  readonly statusKey: string;
  readonly type: DependencyType;
}

export interface ExecutorProposal {
  readonly id: string;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly proposedAgentId: string;
  readonly proposedAgentName: string;
  readonly proposedByAgentId: string;
  readonly proposedByAgentName: string;
  readonly sourceRunId: string | null;
  readonly status: ProposalStatus;
  readonly decidedById: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface InboxItem {
  readonly id: string;
  readonly kind: InboxKind;
  readonly type: InboxItemType;
  readonly issueId: string | null;
  readonly issueIdentifier: string | null;
  readonly title: string;
  readonly body: string;
  readonly actorType: ActorType | null;
  readonly actorName: string | null;
  readonly count: number;
  readonly readAt: string | null;
  readonly archivedAt: string | null;
  readonly resolvedAt: string | null;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectResource {
  readonly id: string;
  readonly projectId: string;
  readonly type: 'gitRepo';
  readonly url: string;
  readonly defaultRef: string | null;
  readonly label: string | null;
  readonly position: number;
}

export interface ProjectMember {
  readonly userId: string;
  readonly name: string;
  readonly role: ProjectMemberRole;
}

export interface Member {
  readonly userId: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: MemberRole;
}

export interface SubtaskSummary {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly statusKey: string;
  readonly stage: number | null;
  readonly executorType: ExecutorType;
  readonly executorName: string | null;
  readonly blockedCount: number;
}

/** Agent write-back interface: POST /np/agent/issues */
export interface AgentCreateIssueRequest {
  readonly title: string;
  readonly description?: string;
  readonly parentIssueId?: string;
  readonly stage?: number;
  readonly blockedBy?: readonly string[];
  readonly priority?: IssuePriority;
  readonly labels?: readonly string[];
  readonly executor?: 'self' | 'none' | (string & {});
}

export interface ClaimedProject {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly resources: readonly {
    readonly type: 'gitRepo';
    readonly url: string;
    readonly defaultRef: string | null;
  }[];
}

/** Fields added to ClaimedRun in iteration 1 (the server merges these into ClaimedRun; the daemon reads them as optional) */
export interface ClaimedRunPhase1Extras {
  readonly project: ClaimedProject | null;
  readonly issue: {
    readonly parent: {
      readonly id: string;
      readonly identifier: string;
      readonly title: string;
    } | null;
    readonly stage: number | null;
    readonly autoExecuteSubtasks: boolean;
    readonly projectId: string | null;
  };
  readonly agent: {
    readonly delegationTargets: readonly {
      readonly id: string;
      readonly name: string;
    }[];
  };
  readonly session: {
    readonly branchName: string | null;
    readonly repoUrl: string | null;
  };
}

export interface CheckoutRecord {
  readonly url: string;
  readonly ref: string | null;
  readonly branchName: string;
  readonly path: string;
}

/** Optional fields added to DaemonCompleteRequest / DaemonFailRequest in iteration 1 */
export interface DaemonReportPhase1Extras {
  readonly branchName?: string;
  readonly repoUrl?: string;
}

export const RUN_ENV_PHASE1 = {
  ...RUN_ENV,
  workDir: 'NOCOPROJECT_WORKDIR',
} as const;

export const REALTIME_TOPICS_PHASE1 = {
  ...REALTIME_TOPICS,
  inbox: 'np:inbox',
} as const;

// ---------- Phase 1 iteration 1: response shapes added by the server implementation (docs/phase1/protocol-iteration-1.md) ----------
//
// Additive only. The "Phase 1 iteration 1" section above holds the types given by the contract; this section
// holds the request / response shapes added during the server implementation.
// The daemon only uses AgentCreateIssueResponse, IssueForAgentV1, AgentContextResponseV1, AgentDependencyRequest.

/** Columns added to issues in iteration 1 (`startDate` / `dueDate` are `YYYY-MM-DD`) */
export interface IssuePhase1Fields {
  readonly stage: number | null;
  readonly startDate: string | null;
  readonly dueDate: string | null;
  readonly autoExecuteSubtasks: boolean;
  readonly suggestedExecutorAgentId: string | null;
}

export type IssueV1 = Issue & IssuePhase1Fields;

export interface IssueRef {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
}

export interface IssueListItemV1 extends IssueListItem, IssuePhase1Fields {
  readonly labels: readonly Label[];
  readonly projectName: string | null;
  readonly subtaskCount: number;
  /** Non-terminal blockedBy predecessors + non-terminal siblings in an earlier stage */
  readonly blockedCount: number;
}

/** Blocking reason: an unfinished blockedBy predecessor, or an unfinished sibling in an earlier stage under the same parent issue */
export interface Blocker {
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  readonly statusKey: string;
  readonly reason: 'dependency' | 'stage';
}

export interface IssueSubscriber {
  readonly userId: string;
  readonly name: string;
  readonly reason: SubscriptionReason;
}

export interface IssueDetailV1 extends IssueDetail {
  readonly issue: IssueListItemV1;
  readonly agentTransitions: readonly StatusTransition[];
  readonly subtasks: readonly SubtaskSummary[];
  readonly blockedBy: readonly IssueDependency[];
  readonly blocks: readonly IssueDependency[];
  readonly blockers: readonly Blocker[];
  /** Proposals on this issue and its direct sub-issues (the parent issue's detail uses these for "accept all") */
  readonly proposals: readonly ExecutorProposal[];
  readonly subscribers: readonly IssueSubscriber[];
  readonly labels: readonly Label[];
  readonly parent: IssueRef | null;
  readonly project: { readonly id: string; readonly name: string } | null;
}

export interface IssueBoardGroup {
  readonly statusKey: string;
  readonly issues: readonly IssueListItemV1[];
}

/** The data of `GET /np/issues?view=board` */
export interface IssueBoardResponse {
  readonly groups: readonly IssueBoardGroup[];
}

export interface IssuePhase1Input {
  readonly stage?: number | null;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly labelIds?: readonly string[];
  readonly autoExecuteSubtasks?: boolean;
  readonly parentIssueId?: string | null;
  /** false = don't start yet: only update fields, don't enqueue (defaults to true) */
  readonly start?: boolean;
}

export interface CreateIssueRequestV1
  extends CreateIssueRequest, IssuePhase1Input {
  /** Predecessor issue id or number */
  readonly blockedBy?: readonly string[];
}

export interface UpdateIssueRequestV1
  extends UpdateIssueRequest, IssuePhase1Input {
  readonly projectId?: string | null;
}

export interface AddDependencyRequest {
  readonly dependsOnIssueId: string;
  readonly type?: DependencyType;
}

export interface DecideProposalRequest {
  readonly reason?: string;
}

export interface AcceptAllProposalsResponse {
  readonly accepted: readonly ExecutorProposal[];
  readonly skipped: readonly {
    readonly proposalId: string;
    readonly code: string;
    readonly message: string;
  }[];
}

export interface ProjectV1 extends Project {
  readonly visibility: ProjectVisibility;
  readonly leadUserId: string | null;
  readonly status: ProjectStatus;
  readonly priority: IssuePriority;
  readonly startDate: string | null;
  readonly dueDate: string | null;
  readonly workflowId: string | null;
}

export interface ProjectIssueCounts {
  readonly total: number;
  /** Count of issues whose status category is done */
  readonly done: number;
  readonly byStatus: Readonly<Record<string, number>>;
}

export interface ProjectListItem extends ProjectV1 {
  readonly leadName: string | null;
  readonly memberCount: number;
  readonly issueCounts: ProjectIssueCounts;
}

export interface ProjectDetail extends ProjectListItem {
  readonly members: readonly ProjectMember[];
  readonly resources: readonly ProjectResource[];
  readonly workflow: Workflow;
}

export interface CreateProjectRequest {
  readonly name: string;
  readonly description?: string | null;
  readonly visibility?: ProjectVisibility;
  readonly leadUserId?: string | null;
  readonly status?: ProjectStatus;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly priority?: IssuePriority;
}

export interface UpdateProjectRequest {
  readonly name?: string;
  readonly description?: string | null;
  readonly visibility?: ProjectVisibility;
  readonly leadUserId?: string | null;
  readonly status?: ProjectStatus;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly priority?: IssuePriority;
  readonly workflowId?: string | null;
}

export interface AddProjectMemberRequest {
  readonly userId: string;
  readonly role?: ProjectMemberRole;
}

export interface CreateProjectResourceRequest {
  readonly type: 'gitRepo';
  readonly url: string;
  readonly defaultRef?: string | null;
  readonly label?: string | null;
}

export interface UpdateProjectResourceRequest {
  readonly url?: string;
  readonly defaultRef?: string | null;
  readonly label?: string | null;
  readonly position?: number;
}

export interface UpdateMemberRequest {
  readonly role: MemberRole;
}

/** `GET /np/me/preferences`, `PATCH /np/me/preferences` (NP-108): the signed-in member's own preferences. */
export interface MemberPreferences {
  /** Chime when the member's pending inbox decisions go up. Defaults to on. */
  readonly inboxChime: boolean;
}

export type UpdateMemberPreferencesRequest = Partial<MemberPreferences>;

export interface CreateLabelRequest {
  readonly name: string;
  readonly color?: LabelColor;
}

export interface UpdateLabelRequest {
  readonly name?: string;
  readonly color?: LabelColor;
}

export interface AgentNameRef {
  readonly id: string;
  readonly name: string;
}

export type AgentV1 = Omit<Agent, 'access'> & {
  readonly access: AgentAccessLevel;
};

export type AgentListItemV1 = Omit<AgentListItem, 'access'> & {
  readonly access: AgentAccessLevel;
  /** Whether the current user can assign, @-mention, or accept a proposal to this agent */
  readonly canInvoke: boolean;
  /** Whether the current user can edit it (the owner, or an owner/admin) */
  readonly canEdit: boolean;
  readonly ownerName: string | null;
  readonly delegationTargets: readonly AgentNameRef[];
  readonly accessUserIds: readonly string[];
};

export type CreateAgentRequestV1 = Omit<CreateAgentRequest, 'access'> & {
  readonly access?: AgentAccessLevel;
  readonly accessUserIds?: readonly string[];
  readonly delegationTargetIds?: readonly string[];
};

export type UpdateAgentRequestV1 = Omit<UpdateAgentRequest, 'access'> & {
  readonly access?: AgentAccessLevel;
  readonly accessUserIds?: readonly string[];
  readonly delegationTargetIds?: readonly string[];
};

export interface UpdateRuntimeRequest {
  readonly visibility: RuntimeVisibility;
}

export interface InboxUnreadCounts {
  readonly decision: number;
  readonly info: number;
}

/** `GET /np/inbox/pending-count`: items still awaiting the current user's decision (unresolved, unarchived, read or not) — used for the nav inbox badge */
export interface InboxPendingCounts {
  readonly decision: number;
}

/** Full response body of `GET /np/inbox` (`unread` and `nextCursor` are siblings of `data`) */
export interface InboxListResponse {
  readonly data: readonly InboxItem[];
  readonly unread: InboxUnreadCounts;
  readonly nextCursor: string | null;
}

export type InboxTopicPayload = { readonly kind: 'inbox.changed' };

/** Issue view in the agent write-back interface (`GET /np/agent/issues/:id`, `/context`) */
export interface IssueForAgentV1 extends IssueForAgent {
  readonly parentIssueId: string | null;
  readonly parent: IssueRef | null;
  readonly projectId: string | null;
  readonly stage: number | null;
  readonly autoExecuteSubtasks: boolean;
  readonly labels: readonly string[];
  readonly blockers: readonly Blocker[];
}

export interface AgentContextResponseV1 extends AgentContextResponse {
  readonly issue: IssueForAgentV1;
  readonly project: ClaimedProject | null;
}

/** Response of POST /np/agent/issues (`issue` is the full issue row merged with the agent view) */
export interface AgentCreateIssueResponse {
  readonly issue: IssueV1 & IssueForAgentV1;
  /** The proposal when executor points at an agent that needs confirmation; status = autoAccepted when auto-accepted */
  readonly proposal: ExecutorProposal | null;
  readonly triggered: readonly TriggeredRun[];
  /** Already blocked at creation (enqueueing deferred) */
  readonly blocked: boolean;
}

/**
 * POST /np/agent/issues/:id/dependencies: `dependsOnIssueId` (CLI usage) or `blockedBy`; either an id or a number works.
 * Delete: `DELETE /np/agent/issues/:id/dependencies?dependsOnIssueId=<id>&type=blockedBy`,
 * or `DELETE /np/agent/issues/:id/dependencies/:dependencyIdOrIssue`.
 */
export interface AgentDependencyRequest {
  readonly blockedBy?: string;
  readonly dependsOnIssueId?: string;
  readonly type?: DependencyType;
}

// ---------- Phase 1 iteration 2 (docs/phase1/iteration-2-contract.md §M) ----------

export * from './protocol.phase1-iter2.js';
// Server-only additional shapes (not copied by the CLI)
export * from './protocol.phase1-iter2-server.js';

// ---------- Phase 1 iteration 3 (docs/phase1/iteration-3-contract.md §J) ----------

export * from './protocol.phase1-iter3.js';
// Server-only composite types (the CLI's sync-protocol drops this line)
export * from './protocol.phase1-iter3-server.js';

// ---------- Phase 1 iteration 4 (docs/phase1/iteration-4-contract.md) ----------

export * from './protocol.phase1-iter4.js';
// Server-only composite types (the CLI's sync-protocol drops this line)
export * from './protocol.phase1-iter4-server.js';

// ---------- Phase 2 workflow stage actions (NP-77) ----------

export * from './protocol.phase2-workflow.js';
// Server-only composite types (the CLI's sync-protocol drops this line)
export * from './protocol.phase2-workflow-server.js';

// ---------- Phase 2 workflow template proposals (NP-77 stage 2) ----------

export * from './protocol.phase2-workflow-proposals.js';

// ---------- Phase 2 signals ----------

export * from './protocol.phase2-signals.js';

// ---------- Email invitations (NP-88) ----------

// Server- and browser-only (the CLI's sync-protocol drops this line)
export * from './protocol.invitations-server.js';

export * from './protocol.capabilities.js';

// ---------- Daemon version compatibility (NP-150) ----------

export * from './protocol.daemon-compat.js';
// Server- and browser-only (the CLI's sync-protocol drops this line)
export * from './protocol.computers-server.js';

// ---------- Business roles in /config/members (NP-153) ----------

// Server- and browser-only (the CLI's sync-protocol drops this line)
export * from './protocol.roles-server.js';

// ---------- Project manager assistant (NP-181 / NP-183) ----------

export * from './protocol.phase2-pm-assistant.js';
