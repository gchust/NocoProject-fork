/**
 * NocoProject 协议类型（Phase 0，protocolVersion 1）。
 *
 * 这是服务端、守护进程 / CLI、前端三方的共同契约。守护进程包里有一份同内容副本
 * （nocoproject-cli/src/protocol.ts）；改这里必须同步改那里，并更新 docs/phase0/protocol.md。
 */

export const PROTOCOL_VERSION = 1 as const;

// ---------- 状态目录 ----------

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

// ---------- 运行 ----------

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

// ---------- 守护进程接口 ----------

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

/** 守护进程订阅的用户主题 `np:daemon` 上的载荷 */
export type DaemonWakeupPayload =
  | { readonly kind: 'workAvailable'; readonly runtimeId: string }
  | { readonly kind: 'cancelRequested'; readonly runId: string };

// ---------- Agent 回写接口 ----------

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
  /** Phase 1 迭代 1：运行所属任务的项目与仓库资源（服务端总是返回，无项目时为 null） */
  readonly project?: ClaimedProject | null;
}

// ---------- 浏览器实时主题 ----------

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

// ---------- 运行令牌 ----------

export const RUN_TOKEN_PREFIX = 'npr_' as const;
export const RUN_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const CLAIM_LEASE_SECONDS = 45;
export const RUNTIME_OFFLINE_AFTER_SECONDS = 150;
export const DISPATCHED_TIMEOUT_SECONDS = 300;
export const RUNTIME_RECONNECT_GRACE_SECONDS = 3 * 60 * 60;

/** CLI 在这些环境变量存在时自动以运行令牌模式工作 */
export const RUN_ENV = {
  serverUrl: 'NOCOPROJECT_SERVER_URL',
  token: 'NOCOPROJECT_TOKEN',
  runId: 'NOCOPROJECT_RUN_ID',
  agentId: 'NOCOPROJECT_AGENT_ID',
  issueId: 'NOCOPROJECT_ISSUE_ID',
  issueKey: 'NOCOPROJECT_ISSUE_KEY',
} as const;

// ---------- 界面接口（浏览器，protocol.md 第 3 节） ----------
//
// 服务端 Phase 0 实现时补充的响应形状（只增不改）。守护进程不使用这些类型。

export type AgentAccess = 'ownerOnly' | 'everyone';
export type RuntimeKind = 'personal' | 'server';
export type RuntimeVisibility = 'private' | 'public';
export type RuntimeStatus = 'online' | 'offline';
export type CommentKind = 'comment' | 'system';

/** 失败响应体：`{ code, message }` 与相应 HTTP 状态码 */
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
  /** dispatched | running 的运行数 */
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
  /** 线程根评论 id（顶层评论为自身 id） */
  readonly rootId: string;
  readonly sourceRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** @temporary(nocobase-official): 待替换为 NocoBase 官方 活动流与变更事件 */
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
  /** 第一条触发的类型 */
  readonly triggerType: RunTriggerType | null;
  readonly status: RunStatus;
  readonly attempt: number;
  readonly threadScope: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Phase 1：Agent 工作分支（守护进程回报），无 checkout 时为 null */
  readonly branchName: string | null;
  readonly repoUrl: string | null;
}

export interface IssueDetail {
  readonly issue: IssueListItem;
  /** 扁平列表，按 createdAt 升序；线程由 parentId / rootId 组织 */
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
  /** 默认当前用户 */
  readonly ownerUserId?: string | null;
  readonly executor?: ExecutorInput;
  /** 默认 todo（服务端补充的可选字段） */
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
  /** dispatched | running 的运行数 */
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
  /** true 归档，false 取消归档 */
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
  /** status === 'online' 且 lastSeenAt 在 150 秒内 */
  readonly online: boolean;
  readonly lastSeenAt: string | null;
  readonly version: string | null;
  readonly capabilities: RuntimeCapabilities | null;
  readonly deviceInfo: Readonly<Record<string, unknown>> | null;
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

/** GET /np/runs/:id/events 的完整响应体（`last` 与 `data` 同级） */
export interface RunEventsResponse {
  readonly data: readonly RunEvent[];
  readonly last: number;
}

/** POST /np/daemon/runs/:id/events 的响应 */
export interface DaemonEventsResponse {
  readonly accepted: number;
  readonly last: number;
}

/** 每批事件上限与单条正文上限（超出截断并 truncated=true） */
export const RUN_EVENTS_MAX_BATCH = 200;
export const RUN_EVENT_MAX_CONTENT_BYTES = 64 * 1024;

// ---------- Phase 1 迭代 1（docs/phase1/iteration-1-contract.md） ----------
//
// 只增不改。守护进程的副本 nocoproject-cli/src/protocol.ts 必须同步。

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

/** 迭代 1 新增的触发类型；与 RunTriggerType 合并使用 */
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
  /** '*' 表示任意 */
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

/** Agent 回写接口：POST /np/agent/issues */
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

/** ClaimedRun 在迭代 1 追加的字段（服务端合并进 ClaimedRun；守护进程按可选读取） */
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

/** DaemonCompleteRequest / DaemonFailRequest 在迭代 1 追加的可选字段 */
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

// ---------- Phase 1 迭代 1：服务端实现补充的响应形状（docs/phase1/protocol-iteration-1.md） ----------
//
// 只增不改。上面 "Phase 1 迭代 1" 段是契约给出的类型；这里是服务端实现时补充的请求 / 响应形状。
// 守护进程只用到 AgentCreateIssueResponse、IssueForAgentV1、AgentContextResponseV1、AgentDependencyRequest。

/** 迭代 1 给任务追加的列（`startDate` / `dueDate` 为 `YYYY-MM-DD`） */
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
  /** 未到终态的 blockedBy 前置 + 更小批次里未到终态的兄弟 */
  readonly blockedCount: number;
}

/** 阻塞原因：未完成的 blockedBy 前置，或同父任务下更小 stage 的未完成兄弟 */
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
  /** 本任务及其直接子任务上的建议（父任务详情据此"全部确认"） */
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

/** `GET /np/issues?view=board` 的 data */
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
  /** false = 暂不开始：只改字段，不入队（默认 true） */
  readonly start?: boolean;
}

export interface CreateIssueRequestV1
  extends CreateIssueRequest, IssuePhase1Input {
  /** 前置任务 id 或编号 */
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
  /** 状态分类为 done 的任务数 */
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
  /** 当前用户能否分配、@ 或确认建议给这个 Agent */
  readonly canInvoke: boolean;
  /** 当前用户能否编辑它（所有者或 owner/admin） */
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

/** `GET /np/inbox/pending-count`：仍等当前用户决定的项（未解决、未归档，已读也算），导航收件箱角标用 */
export interface InboxPendingCounts {
  readonly decision: number;
}

/** `GET /np/inbox` 的完整响应体（`unread`、`nextCursor` 与 `data` 同级） */
export interface InboxListResponse {
  readonly data: readonly InboxItem[];
  readonly unread: InboxUnreadCounts;
  readonly nextCursor: string | null;
}

export type InboxTopicPayload = { readonly kind: 'inbox.changed' };

/** Agent 回写接口里的任务视图（`GET /np/agent/issues/:id`、`/context`） */
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

/** POST /np/agent/issues 的响应（`issue` 是完整任务行合并 Agent 视图） */
export interface AgentCreateIssueResponse {
  readonly issue: IssueV1 & IssueForAgentV1;
  /** executor 指向需要确认的 Agent 时的建议；自动接受时 status = autoAccepted */
  readonly proposal: ExecutorProposal | null;
  readonly triggered: readonly TriggeredRun[];
  /** 创建时已被阻塞（入队被推迟） */
  readonly blocked: boolean;
}

/**
 * POST /np/agent/issues/:id/dependencies：`dependsOnIssueId`（CLI 用法）或 `blockedBy`，id 或编号均可。
 * 删除：`DELETE /np/agent/issues/:id/dependencies?dependsOnIssueId=<id>&type=blockedBy`，
 * 或 `DELETE /np/agent/issues/:id/dependencies/:dependencyIdOrIssue`。
 */
export interface AgentDependencyRequest {
  readonly blockedBy?: string;
  readonly dependsOnIssueId?: string;
  readonly type?: DependencyType;
}

// ---------- Phase 1 迭代 2（docs/phase1/iteration-2-contract.md §M） ----------

export * from './protocol.phase1-iter2.js';
// 服务端补充形状（CLI 不复制）
export * from './protocol.phase1-iter2-server.js';

// ---------- Phase 1 迭代 3（docs/phase1/iteration-3-contract.md §J） ----------

export * from './protocol.phase1-iter3.js';
// 服务端专用的组合类型（CLI 的 sync-protocol 去掉这一行）
export * from './protocol.phase1-iter3-server.js';

// ---------- Phase 1 迭代 4（docs/phase1/iteration-4-contract.md） ----------

export * from './protocol.phase1-iter4.js';
// 服务端专用的组合类型（CLI 的 sync-protocol 去掉这一行）
export * from './protocol.phase1-iter4-server.js';

// ---------- Phase 2 工作流阶段动作（NP-77） ----------

export * from './protocol.phase2-workflow.js';
// 服务端专用的组合类型（CLI 的 sync-protocol 去掉这一行）
export * from './protocol.phase2-workflow-server.js';

// ---------- Phase 2 工作流模板提议（NP-77 stage 2） ----------

export * from './protocol.phase2-workflow-proposals.js';

// ---------- 邮箱邀请（NP-88） ----------

// 服务端与浏览器专用（CLI 的 sync-protocol 去掉这一行）
export * from './protocol.invitations-server.js';
