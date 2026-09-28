/**
 * Browser-side types for the NocoProject pages (Phase 0, protocol version 1).
 *
 * The contract is `docs/phase0/protocol.md` §1, §3 and §6. The shared vocabulary (status catalog, run status,
 * trigger types, event types, topic payloads) is copied from `server/modules/shared/protocol.ts` rather than imported:
 * the client tsconfig includes only `client/`, and a type import into `server/` would drag server sources into the
 * browser type check. Keep the copied unions in step with that file.
 *
 * The response shapes below (`IssueListItem`, `IssueDetail`, `AgentListItem`, …) are what §3 describes in prose
 * ("owner/executor names, active run count", "issue + comments(tree) + activities + runs(summary) + statusCatalog").
 * Fields the prose does not pin down are optional here, and `detail-normalize.ts` accepts the plausible variants so
 * the page keeps working while the server contract settles.
 */

import type {
  ApprovalRequest,
  CommentReaction,
  ExecutionMode,
  IssuePullRequestView,
  QueuedRun,
  UsageRow,
} from './types-iter2.js';
import type {
  AgentAccessLevel,
  ExecutorProposal,
  IssueDependency,
  IssueRef,
  IssueSubscriber,
  Label,
  LabelColor,
  SubtaskSummary,
} from './types-collab.js';
import type {
  AgentKind,
  CommentKindPhase1Iter4,
  DesignProposal,
  IssueProcess,
  ProcessChoice,
  ReasoningEffort,
  RunTriggerTypePhase1Iter4,
} from './types-iter4.js';

export type * from './types-collab.js';
export type * from './types-iter2.js';

// ---------- copied from server/modules/shared/protocol.ts ----------

export type StatusCategory = 'unstarted' | 'started' | 'done' | 'closed';

export interface StatusCatalogEntry {
  readonly key: string;
  readonly category: StatusCategory;
  readonly agentWritable: boolean;
  /** The workflow's color for the status (iteration 3 §H 4); `statusColor` falls back to the built-in colors. */
  readonly color?: LabelColor;
}

export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export type ExecutorType = 'user' | 'agent' | 'none';

export type ActorType = 'user' | 'agent' | 'system';

export type RunStatus =
  | 'queued'
  | 'deferred'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunTriggerType =
  | 'assign'
  | 'statusChange'
  | 'mention'
  | 'reply'
  | 'comment'
  | 'retry'
  | 'dependencyReleased'
  | 'childBatchDone'
  | 'proposalAccepted'
  | RunTriggerTypePhase1Iter4;

export type RunEventType =
  'text' | 'thinking' | 'toolUse' | 'toolResult' | 'status' | 'error';

export type AgentProvider = 'claude' | 'opencode' | 'codex' | 'echo';

export type IssuesTopicPayload = {
  readonly kind: 'issue.changed';
  readonly issueId: string;
};
export type AgentsTopicPayload = { readonly kind: 'agents.changed' };
export type RunTopicPayload =
  | { readonly kind: 'run.events'; readonly last: number }
  | { readonly kind: 'run.status'; readonly status: RunStatus };

// ---------- browser API shapes (protocol §3) ----------

export interface Me {
  readonly userId: string;
  readonly name: string;
}

/** `GET /np/me/preferences` (NP-108): the viewer's own preferences, kept with the account. */
export interface MemberPreferences {
  readonly inboxChime: boolean;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface ExecutorRef {
  readonly type: ExecutorType;
  readonly id: string | null;
}

/** One row of `GET /np/issues`. */
export interface IssueListItem {
  readonly id: string;
  readonly number?: number;
  readonly identifier: string;
  readonly title: string;
  readonly statusKey: string;
  readonly priority: IssuePriority;
  readonly ownerUserId: string | null;
  readonly ownerName?: string | null;
  readonly executorType: ExecutorType;
  readonly executorId: string | null;
  readonly executorName?: string | null;
  readonly activeRunCount?: number;
  readonly projectId?: string | null;
  readonly revision?: number;
  readonly lastActivityAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt: string;
  // Phase 1 iteration 1 (§A, §G)
  readonly stage?: number | null;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly parentIssueId?: string | null;
  readonly autoExecuteSubtasks?: boolean;
  readonly suggestedExecutorAgentId?: string | null;
  readonly labels?: readonly Label[];
  readonly projectName?: string | null;
  readonly subtaskCount?: number;
  /** Open `blockedBy` blockers plus unfinished siblings in lower stages (§D). */
  readonly blockedCount?: number;
  // Phase 1 iteration 2 (§A, §J)
  readonly executionMode?: ExecutionMode;
  readonly originType?: 'manual' | 'intake' | 'agent' | 'pm';
  readonly originId?: string | null;
  // Phase 1 iteration 4 (§A, §B)
  readonly process?: IssueProcess;
  readonly designApprovedAt?: string | null;
  readonly designApprovedById?: string | null;
}

/** The issue record inside `GET /np/issues/:id`. */
export interface Issue extends IssueListItem {
  readonly description: string | null;
  readonly revision: number;
  readonly createdById?: string | null;
  readonly createdAt: string;
  /** Iteration 4 §B: the latest design proposal, when the detail carries it. */
  readonly designProposal?: DesignProposal | null;
}

export interface IssueComment {
  readonly id: string;
  readonly issueId?: string;
  readonly authorType: ActorType;
  readonly authorId: string | null;
  readonly authorName?: string | null;
  readonly content: string;
  readonly kind?: 'comment' | 'system' | CommentKindPhase1Iter4;
  readonly parentId: string | null;
  readonly sourceRunId?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string;
  /** Present when the server returns the tree nested; flat lists are nested by `normalizeComments`. */
  readonly replies?: readonly IssueComment[];
  readonly children?: readonly IssueComment[];
  // Phase 1 iteration 2 (§F): reactions, and the thread resolution on a root comment.
  readonly reactions?: readonly CommentReaction[];
  readonly resolvedAt?: string | null;
  readonly resolvedById?: string | null;
  readonly resolvedByName?: string | null;
}

/** A top-level comment with every descendant flattened into chronological replies. */
export interface CommentThread {
  readonly root: IssueComment;
  readonly replies: readonly IssueComment[];
}

export interface IssueActivity {
  readonly id: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly actorName?: string | null;
  readonly action: string;
  readonly details?: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface RunTrigger {
  readonly id?: string;
  readonly type: RunTriggerType;
  readonly commentId?: string | null;
  readonly createdAt?: string;
}

/** A run summary in the issue detail, and `GET /np/runs/:id`. */
export interface RunSummary {
  readonly id: string;
  readonly agentId: string;
  readonly agentName?: string | null;
  readonly runtimeId?: string | null;
  readonly status: RunStatus;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly retryOfRunId?: string | null;
  readonly triggerType?: RunTriggerType | null;
  readonly triggers?: readonly RunTrigger[];
  readonly failureReason?: string | null;
  readonly failureDetail?: string | null;
  readonly resultSummary?: string | null;
  readonly cancelRequestedAt?: string | null;
  readonly createdAt: string;
  readonly dispatchedAt?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly branchName?: string | null;
  readonly repoUrl?: string | null;
}

/** `GET /np/issues/:id`, normalized. */
export interface IssueDetail {
  readonly issue: Issue;
  readonly threads: readonly CommentThread[];
  readonly activities: readonly IssueActivity[];
  readonly runs: readonly RunSummary[];
  readonly statusCatalog: readonly StatusCatalogEntry[];
  // Phase 1 iteration 1 (§D): always present after normalization, empty when the server omits them.
  readonly subtasks: readonly SubtaskSummary[];
  readonly blockedBy: readonly IssueDependency[];
  readonly blocks: readonly IssueDependency[];
  readonly proposals: readonly ExecutorProposal[];
  readonly subscribers: readonly IssueSubscriber[];
  readonly labels: readonly Label[];
  readonly parent: IssueRef | null;
  readonly project: { readonly id: string; readonly name: string } | null;
  // Phase 1 iteration 2 (§C, §D, §I, §J): always present after normalization.
  readonly pullRequests: readonly IssuePullRequestView[];
  readonly approvals: readonly ApprovalRequest[];
  readonly queuedRun: QueuedRun | null;
  /** The issue's usage when the detail carries it; the panel otherwise asks `GET /np/usage`. */
  readonly usage: UsageRow | null;
  /** Iteration 3 §D: older activities page from here; null when the detail holds them all. */
  readonly activitiesNextCursor?: string | null;
}

export interface AgentListItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly ownerUserId?: string | null;
  readonly instructions?: string | null;
  readonly runtimeId: string | null;
  readonly runtimeName?: string | null;
  /** Either field may carry the runtime's state; `isRuntimeOnline` reads both. */
  readonly runtimeStatus?: 'online' | 'offline' | null;
  readonly runtimeOnline?: boolean | null;
  /** One of `AgentProvider`; typed as a string so a newer daemon's provider still renders. */
  readonly provider: string;
  readonly model?: string | null;
  readonly maxConcurrentRuns?: number;
  readonly access?: AgentAccessLevel;
  readonly activeRunCount?: number;
  // Phase 1 iteration 1 (§H)
  readonly canInvoke?: boolean;
  /** Whether the viewer may edit it (its owner, or owner/admin). */
  readonly canEdit?: boolean;
  readonly ownerName?: string | null;
  readonly delegationTargets?: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly accessUserIds?: readonly string[];
  // Phase 1 iteration 2 (§H)
  readonly skillIds?: readonly string[];
  readonly archivedAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  // Phase 1 iteration 4 (§C)
  readonly kind?: AgentKind;
  readonly reasoningEffort?: ReasoningEffort | null;
}

export interface Runtime {
  readonly id: string;
  readonly daemonId?: string;
  /** One of `AgentProvider`; typed as a string so a newer daemon's provider still renders. */
  readonly provider: string;
  readonly name: string;
  readonly kind: 'personal' | 'server';
  readonly ownerUserId?: string | null;
  readonly ownerName?: string | null;
  readonly visibility?: 'private' | 'public';
  readonly status: 'online' | 'offline';
  readonly lastSeenAt: string | null;
  readonly capabilities?: Record<string, unknown> | null;
  readonly deviceInfo?: Record<string, unknown> | null;
  readonly version?: string | null;
  readonly createdAt?: string;
}

export interface RunEvent {
  readonly id?: string;
  readonly seq: number;
  readonly type: RunEventType;
  readonly tool?: string | null;
  readonly content?: string | null;
  readonly input?: unknown;
  readonly output?: string | null;
  readonly truncated?: boolean;
  readonly at: string;
}

export interface RunEventsResponse {
  readonly data: readonly RunEvent[];
  readonly last: number | null;
}

export interface CreateIssueInput {
  readonly title: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  readonly projectId?: string;
  readonly ownerUserId?: string;
  readonly executor?: ExecutorRef;
  // Phase 1 iteration 1 (§G)
  readonly statusKey?: string;
  readonly parentIssueId?: string;
  readonly stage?: number;
  readonly blockedBy?: readonly string[];
  readonly labelIds?: readonly string[];
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly autoExecuteSubtasks?: boolean;
  readonly start?: boolean;
  readonly executionMode?: ExecutionMode;
  /** Iteration 4 §B; `auto` lets the server classify, omitted it applies `settings.defaultProcess`. */
  readonly process?: ProcessChoice;
  /** NP-78: the caller's own unattached uploads to attach to the new issue. */
  readonly attachmentIds?: readonly string[];
}

export interface UpdateIssueInput {
  readonly title?: string;
  readonly description?: string;
  readonly statusKey?: string;
  readonly priority?: IssuePriority;
  readonly ownerUserId?: string;
  readonly executor?: ExecutorRef;
  // Phase 1 iteration 1 (§G)
  readonly stage?: number | null;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly labelIds?: readonly string[];
  readonly autoExecuteSubtasks?: boolean;
  readonly parentIssueId?: string | null;
  readonly projectId?: string | null;
  /** `false` changes the fields without queueing a run ("don't start now"); the server defaults to `true`. */
  readonly start?: boolean;
  readonly executionMode?: ExecutionMode;
  /** Iteration 4 §B: only while the issue is in backlog / todo (409 `PROCESS_LOCKED` otherwise). */
  readonly process?: IssueProcess;
}

export interface CreateCommentResult {
  readonly comment: IssueComment;
  readonly triggered: readonly {
    readonly agentId: string;
    readonly runId: string;
  }[];
}

export interface CreateAgentInput {
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  readonly runtimeId: string;
  readonly provider: string;
  readonly model?: string;
  readonly maxConcurrentRuns?: number;
  readonly access?: AgentAccessLevel;
  // Phase 1 iteration 4 (§C)
  readonly kind?: AgentKind;
  readonly reasoningEffort?: ReasoningEffort | null;
}

/** `PATCH /np/agents/:id` (§H). */
export interface UpdateAgentInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly instructions?: string;
  readonly runtimeId?: string;
  readonly provider?: string;
  readonly model?: string | null;
  readonly maxConcurrentRuns?: number;
  readonly access?: AgentAccessLevel;
  readonly accessUserIds?: readonly string[];
  readonly delegationTargetIds?: readonly string[];
  readonly skillIds?: readonly string[];
  readonly archived?: boolean;
  // Phase 1 iteration 4 (§C)
  readonly kind?: AgentKind;
  readonly reasoningEffort?: ReasoningEffort | null;
}
