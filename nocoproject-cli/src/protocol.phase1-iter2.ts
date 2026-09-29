/**
 * NocoProject protocol types: Phase 1 iteration 2 additions (docs/phase1/iteration-2-contract.md §M;
 * implementation in docs/phase1/protocol-iteration-2.md).
 *
 * Server source of truth; the daemon package keeps an identical copy
 * (nocoproject-cli/src/protocol.phase1-iter2.ts) that a change here must be mirrored to. This file only
 * imports from protocol.ts the types that are also in the CLI's copy; composite types that depend on
 * server-only additional shapes (IssueV1, etc.) live in protocol.phase1-iter2-server.ts (not copied by
 * the CLI).
 * Additive only: iteration 1's types stay unchanged, and places that need more fields this round use
 * `…V2` intersection types; enum values the contract §M asks to "append" are written as separate types
 * (InboxItemTypePhase1Iter2, etc.) used merged with the original union type — the original union in
 * protocol.ts is not changed.
 */
import type {
  Comment,
  CommentForAgent,
  ExecutorInput,
  FailureReason,
  InboxItem,
  InboxItemType,
  IssuePriority,
  RunSummary,
  WorkflowTransitionDefinition,
} from './protocol.js';

// ---------- Session mode and issue origin (§A, §J) ----------

export type ExecutionMode = 'task' | 'session';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['task', 'session'];

/** Iteration 4 adds `pm`: a project manager conversation issue (docs/phase1/iteration-4-contract.md §C) */
export type IssueOriginType = 'manual' | 'intake' | 'agent' | 'pm';

/** Columns added to issues in iteration 2 */
export interface IssuePhase2Fields {
  readonly executionMode: ExecutionMode;
  readonly originType: IssueOriginType;
  /** intake → batch id; agent → the run id that created it; manual → null */
  readonly originId: string | null;
}

// ---------- GitHub integration (§C) ----------

export interface GitConnectionView {
  readonly configured: boolean;
  readonly apiBaseUrl: string;
  readonly tokenSet: boolean;
  readonly webhookSecretSet: boolean;
  readonly webhookUrl: string;
  readonly lastEventAt: string | null;
}

/** Omitted field = unchanged; empty string = clear */
export interface UpdateGitConnectionRequest {
  readonly apiBaseUrl?: string;
  readonly token?: string;
  readonly webhookSecret?: string;
}

export interface GitConnectionTestResponse {
  readonly ok: boolean;
  readonly login: string;
  readonly scopes?: readonly string[];
}

export type PullRequestState = 'open' | 'closed' | 'merged';
export type PullRequestCiState = 'pending' | 'success' | 'failure';
export type PullRequestLinkedByType = 'user' | 'agent' | 'system';

export interface PullRequest {
  readonly id: string;
  readonly connectionId: string | null;
  /** `owner/name` */
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: PullRequestState;
  readonly draft: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly authorLogin: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly mergeableState: string | null;
  readonly ciState: PullRequestCiState | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly snapshotAt: string | null;
}

export interface IssuePullRequestView extends PullRequest {
  readonly linkedBy: {
    readonly type: PullRequestLinkedByType;
    readonly id: string | null;
    readonly name: string | null;
  };
  readonly autoCompleteDisabled: boolean;
  /** The server always returns this (link time); the CLI does not read it */
  readonly linkedAt?: string;
}

export interface LinkPullRequestRequest {
  readonly url: string;
}

export interface UpdateIssuePullRequestRequest {
  readonly autoCompleteDisabled: boolean;
}

/** Agent write-back: POST /np/agent/issues/:id/pull-requests */
export interface AgentPullRequestLinkRequest {
  readonly url: string;
}

// ---------- Approval gate (§D) ----------

/** @temporary(nocobase-official): to be replaced by NocoBase's official workflow approvals (the enum values must not change when it is replaced) */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type ApproverRole = 'owner' | 'projectLead' | 'admin';
export const APPROVER_ROLES: readonly ApproverRole[] = [
  'owner',
  'projectLead',
  'admin',
];

/** `workflowTemplates.definition.transitions[].approval` (optional) */
export interface TransitionApproval {
  readonly approvers: readonly ApproverRole[];
}

export type WorkflowTransitionDefinitionV2 = WorkflowTransitionDefinition & {
  readonly approval?: TransitionApproval;
};

/** @temporary(nocobase-official): to be replaced by NocoBase's official workflow approvals */
export interface ApprovalRequest {
  readonly id: string;
  readonly issueId: string;
  readonly issueIdentifier: string | null;
  readonly issueTitle: string | null;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly requestedByType: 'user' | 'agent';
  readonly requestedById: string;
  readonly requestedByName: string | null;
  readonly requestedRunId: string | null;
  readonly approverUserIds: readonly string[];
  readonly status: ApprovalStatus;
  readonly decidedById: string | null;
  readonly decidedByName: string | null;
  readonly decidedAt: string | null;
  readonly comment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DecideApprovalRequest {
  readonly comment?: string;
}

/**
 * The 202 response body `data` when `PATCH /np/issues/:id { statusKey }` or
 * `POST /np/agent/issues/:id/status` hits the gate: the issue is unchanged (the whole PATCH did not
 * take effect), and an approval request has been created.
 */
export interface StatusChangePendingResponse {
  /** The unchanged issue (the server returns the full IssueV2 row; only the fields the CLI reads are listed here) */
  readonly issue: IssueStatusSnapshot;
  readonly pendingApproval: ApprovalRequest;
}

/** Status-related fields on the issue row (see the server's IssueV2 for the full row) */
export type IssueStatusSnapshot = {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly statusKey: string;
  readonly revision: number;
} & IssuePhase2Fields;

// ---------- Reactions and threads (§F) ----------

export const REACTION_EMOJIS = [
  '👍',
  '👀',
  '🎉',
  '❤️',
  '🚀',
  '😄',
  '🤔',
  '👎',
] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export interface CommentReaction {
  readonly emoji: ReactionEmoji;
  readonly count: number;
  readonly userIds: readonly string[];
}

export interface AddReactionRequest {
  readonly emoji: string;
}

/** Fields added to the comment row (comments in the browser detail view) */
export interface CommentV2 extends Comment {
  readonly reactions: readonly CommentReaction[];
  /** Only set on the thread's root comment */
  readonly resolvedAt: string | null;
  readonly resolvedById: string | null;
  readonly resolvedByName: string | null;
}

/** The agent view of a comment: `resolved` = its thread has been resolved */
export interface CommentForAgentV2 extends CommentForAgent {
  readonly resolved: boolean;
}

// ---------- Environment variables (§G) ----------

export const AGENT_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
/** Reserved names: the `NOCOPROJECT_*` prefix plus these names (server returns 400 RESERVED_ENV_NAME; the daemon skips them when injecting) */
export const RESERVED_ENV_NAMES: readonly string[] = ['PATH', 'HOME', 'SHELL'];
export const RESERVED_ENV_PREFIX = 'NOCOPROJECT_';
export const AGENT_ENV_MAX_VALUE_BYTES = 8 * 1024;
/** The daemon only redacts values with length ≥ 6 (to avoid replacing something like `1` entirely) */
export const AGENT_ENV_REDACT_MIN_LENGTH = 6;

export interface AgentEnvVarView {
  readonly name: string;
  readonly updatedAt: string;
  readonly updatedByName: string | null;
}

export interface AgentEnvVarInput {
  readonly name: string;
  readonly value: string;
}

export interface PutAgentEnvRequest {
  readonly vars: readonly AgentEnvVarInput[];
}

export interface AgentEnvRevealItem {
  readonly name: string;
  readonly value: string;
}

export type AgentEnvAuditAction = 'reveal' | 'set' | 'delete';

export interface AgentEnvAudit {
  readonly id: string;
  readonly agentId: string;
  readonly userId: string;
  readonly userName: string | null;
  readonly action: AgentEnvAuditAction;
  readonly names: readonly string[];
  readonly createdAt: string;
}

// ---------- Skills (§H) ----------

export type SkillSource = 'manual' | 'import';

export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly content: string;
  readonly source: SkillSource;
  readonly createdById: string;
  readonly createdByName: string | null;
  readonly fileCount: number;
  /** Number of agents this skill is attached to */
  readonly agentCount: number;
  /** Whether the current user can modify it (the creator, or an owner/admin) */
  readonly canEdit: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

/** An agent the skill is mounted on (visible to every member; excludes deleted agents). */
export interface SkillAgentRef {
  readonly id: string;
  readonly name: string;
}

export interface SkillDetail {
  readonly skill: Skill;
  readonly files: readonly SkillFile[];
  readonly agents: readonly SkillAgentRef[];
}

export interface CreateSkillRequest {
  readonly name: string;
  readonly description?: string;
  readonly content?: string;
  readonly source?: SkillSource;
}

export interface UpdateSkillRequest {
  readonly name?: string;
  readonly description?: string;
  readonly content?: string;
}

export interface PutSkillFilesRequest {
  readonly files: readonly SkillFile[];
}

export const SKILL_MAX_FILES = 20;
export const SKILL_MAX_FILE_BYTES = 64 * 1024;

/** Element of the claim payload's `agent.skills[]` */
export interface ClaimedSkill {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly files: readonly SkillFile[];
}

export interface SkillRef {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

// ---------- Bulk intake (§E) ----------

export type IntakeSource = 'paste' | 'issue';
export type IntakeParserKind = 'ai' | 'heuristic';
export type IntakeBatchStatus =
  'draft' | 'confirmed' | 'cancelled' | 'reverted';

export interface IntakeDraftFields {
  readonly title: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  readonly labels?: readonly string[];
  readonly stage?: number | null;
  readonly executor?: ExecutorInput | null;
  readonly ownerUserId?: string | null;
}

export interface IntakeDraftInput {
  readonly position: number;
  readonly parentPosition: number | null;
  readonly fields: IntakeDraftFields;
}

export interface IntakeDraft extends IntakeDraftInput {
  readonly id: string;
  readonly batchId: string;
  readonly validation: { readonly errors: readonly string[] };
  readonly createdIssueId: string | null;
}

export interface IntakeBatch {
  readonly id: string;
  readonly createdById: string;
  readonly projectId: string | null;
  readonly source: IntakeSource;
  /** The issue that was split, when source = issue */
  readonly sourceIssueId: string | null;
  readonly rawContent: string;
  readonly parser: IntakeParserKind;
  readonly status: IntakeBatchStatus;
  readonly aiSessionId: string | null;
  readonly confirmedAt: string | null;
  /** The reason when AI parsing failed and it fell back to the heuristic parser */
  readonly parseError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreateIntakeBatchRequest =
  | {
      readonly source: 'paste';
      readonly rawContent: string;
      readonly projectId?: string | null;
    }
  | { readonly source: 'issue'; readonly issueId: string };

export interface CreateIntakeBatchResponse {
  readonly batch: IntakeBatch;
  readonly drafts: readonly IntakeDraft[];
  readonly parser: IntakeParserKind;
}

export interface IntakeBatchDetail {
  readonly batch: IntakeBatch;
  readonly drafts: readonly IntakeDraft[];
}

export interface PutIntakeDraftsRequest {
  readonly drafts: readonly IntakeDraftInput[];
}

export interface ConfirmIntakeRequest {
  readonly ownerUserId?: string | null;
  readonly defaultExecutor?: ExecutorInput | null;
}

export interface ConfirmIntakeResponse {
  readonly issues: readonly {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
  }[];
}

// ---------- Usage and settings (§I) ----------

export type UsageGroupBy = 'agent' | 'issue' | 'project' | 'day' | 'model';
export const USAGE_GROUP_BYS: readonly UsageGroupBy[] = [
  'agent',
  'issue',
  'project',
  'day',
  'model',
];

export interface UsageRow {
  readonly key: string;
  readonly name: string;
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedCost: number | null;
  /** Only on totals: number of runs with a price */
  readonly pricedRuns?: number;
}

export interface UsageResponse {
  readonly rows: readonly UsageRow[];
  readonly totals: UsageRow & { readonly pricedRuns: number };
}

export interface ModelPrice {
  readonly provider: string;
  /** A glob, e.g. `claude-*` */
  readonly model: string;
  readonly inputPerM: number;
  readonly outputPerM: number;
  readonly cacheReadPerM: number;
  readonly cacheWritePerM: number;
}

export type IntakeParserSetting = 'auto' | 'heuristic';

/** `GET /np/settings` (systemSettings.settings; an omitted key takes its default value) */
export interface WorkspaceSettingsView {
  readonly autoExecuteSubtasksDefault: boolean;
  /** A status key, or `'none'` to mean don't change status after a PR merges */
  readonly prMergedStatus: string;
  readonly modelPrices: readonly ModelPrice[];
  readonly intakeParser: IntakeParserSetting;
  /** Read-only: the issue number prefix */
  readonly issuePrefix: string;
  /** Read-only: whether the current user can modify it (owner/admin) */
  readonly canEdit: boolean;
}

export interface UpdateWorkspaceSettingsRequest {
  readonly autoExecuteSubtasksDefault?: boolean;
  readonly prMergedStatus?: string;
  readonly modelPrices?: readonly ModelPrice[];
  readonly intakeParser?: IntakeParserSetting;
}

// ---------- Issue detail and runs (§C, §D, §F, §I, §J) ----------

/** The queued run in session mode (sent once the current round finishes) */
export interface QueuedRunRef {
  readonly id: string;
  readonly triggerCount: number;
}

/** Full response body of `GET /np/issues/:id/runs` (`queuedRun` is a sibling of `data`) */
export interface IssueRunsResponse {
  readonly data: readonly RunSummary[];
  readonly queuedRun: QueuedRunRef | null;
}

// ---------- Claim payload additions (§L) ----------

/** Element of the claim payload's `issue.pullRequests[]` */
export interface ClaimedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState;
}

/** Fields added to ClaimedRun in iteration 2 (the server merges these into ClaimedRun; the daemon reads them as optional) */
export interface ClaimedRunPhase2Extras {
  readonly agent: {
    /** Decrypted environment variables; only sent over the daemon route */
    readonly env: Readonly<Record<string, string>>;
    readonly skills: readonly ClaimedSkill[];
  };
  readonly issue: {
    readonly executionMode: ExecutionMode;
    readonly pullRequests: readonly ClaimedPullRequest[];
  };
}

// ---------- Added enum values ----------

export type InboxItemTypePhase1Iter2 =
  'approval_pending' | 'approval_decided' | 'pr_review' | 'pr_merged';
/** All inbox types across iteration 1 and iteration 2 */
export type InboxItemTypeV2 = InboxItemType | InboxItemTypePhase1Iter2;
/** An inbox item (`type` includes iteration 2's types) */
export type InboxItemV2 = Omit<InboxItem, 'type'> & {
  readonly type: InboxItemTypeV2;
};
export type RunFailureReasonPhase1Iter2 = 'blocked';
/** A run's failure reason (includes iteration 2's `blocked`: a queued run withdrawn because a new blocking dependency was added) */
export type FailureReasonV2 = FailureReason | RunFailureReasonPhase1Iter2;
export type ActivityActionPhase1Iter2 =
  | 'pr_linked'
  | 'pr_unlinked'
  | 'pr_merged'
  | 'approval_requested'
  | 'approval_approved'
  | 'approval_rejected'
  | 'approval_self'
  | 'approval_no_approver'
  | 'thread_resolved'
  | 'thread_unresolved'
  | 'execution_mode_changed'
  | 'env_changed'
  | 'skills_changed'
  | 'intake_confirmed'
  | 'intake_reverted';
