/**
 * Browser-side types for Phase 1 iteration 1 (`docs/phase1/iteration-1-contract.md` §D–§H).
 *
 * Copied from the "Phase 1 迭代 1" section of `server/modules/shared/protocol.ts` for the same reason as `types.ts`:
 * the client tsconfig must not reach into `server/`. Response shapes the contract describes only in prose
 * (`ProjectListItem`, `ProjectDetail`, the inbox list envelope) mark the fields it does not pin down as optional.
 */
import type {
  ActorType,
  ExecutorType,
  IssueListItem,
  IssuePriority,
  StatusCategory,
} from './types.js';

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
  | 'status_changed'
  // Phase 1 iteration 2 (§M)
  | 'approval_pending'
  | 'approval_decided'
  | 'pr_review'
  | 'pr_merged';
export type AgentAccessLevel = 'ownerOnly' | 'specificUsers' | 'everyone';

export type InboxTopicPayload = { readonly kind: 'inbox.changed' };

export interface WorkflowStatusDefinition {
  readonly key: string;
  readonly name: string;
  readonly category: StatusCategory;
  readonly color: LabelColor;
  readonly builtIn: boolean;
}

export interface WorkflowTransitionDefinition {
  readonly from: string;
  readonly to: string;
  readonly actors: readonly ('user' | 'agent' | 'system')[];
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
  readonly type?: DependencyType;
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

export interface IssueSubscriber {
  readonly userId: string;
  readonly name: string;
  readonly reason: SubscriptionReason;
}

export interface SubtaskSummary {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly statusKey: string;
  readonly stage: number | null;
  readonly executorType?: ExecutorType;
  readonly executorName: string | null;
  readonly blockedCount: number;
}

export interface IssueRef {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
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

export interface InboxUnread {
  readonly decision: number;
  readonly info: number;
}

/** `GET /np/inbox/pending-count`: decisions still waiting on the viewer (not resolved, not archived, read or not). */
export interface InboxPending {
  readonly decision: number;
}

export interface InboxListResponse {
  readonly data: readonly InboxItem[];
  readonly unread?: InboxUnread;
  readonly nextCursor?: string | null;
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

export interface ProjectIssueCounts {
  readonly total: number;
  readonly done: number;
  readonly byStatus?: Readonly<Record<string, number>>;
}

/** One row of `GET /np/projects` (§F). */
export interface ProjectListItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly visibility?: ProjectVisibility;
  readonly status?: ProjectStatus;
  readonly priority?: IssuePriority;
  readonly leadUserId?: string | null;
  readonly leadName?: string | null;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly memberCount?: number;
  readonly issueCounts?: ProjectIssueCounts;
  readonly workflowId?: string | null;
  readonly updatedAt?: string;
}

/** `GET /np/projects/:id` (§F). */
export interface ProjectDetail extends ProjectListItem {
  readonly members?: readonly ProjectMember[];
  readonly resources?: readonly ProjectResource[];
  readonly workflow?: Workflow | null;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly visibility?: ProjectVisibility;
  readonly leadUserId?: string;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly priority?: IssuePriority;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly visibility?: ProjectVisibility;
  readonly status?: ProjectStatus;
  readonly priority?: IssuePriority;
  readonly leadUserId?: string | null;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly workflowId?: string | null;
}

/** `GET /np/issues?view=board`: issues grouped by status (§F). */
export interface BoardGroup {
  readonly statusKey: string;
  readonly issues: readonly IssueListItem[];
}

/** Filters `GET /np/issues` accepts (§F), which the list and the board keep in the URL. */
export interface IssueFilters {
  readonly q?: string;
  readonly statusKey?: string;
  readonly projectId?: string;
  readonly labelId?: string;
  readonly ownerUserId?: string;
  readonly executorId?: string;
  readonly parentIssueId?: string;
}

/** The "confirm start" answer sent with a PATCH or create (§G). */
export interface StartDecision {
  readonly start: boolean;
  readonly autoExecuteSubtasks: boolean;
}
