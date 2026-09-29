/**
 * NocoProject 协议类型：Phase 1 迭代 2 追加（docs/phase1/iteration-2-contract.md §M，实现见
 * docs/phase1/protocol-iteration-2.md）。
 *
 * 服务端正本；守护进程包里有同内容副本（nocoproject-cli/src/protocol.phase1-iter2.ts），改这里必须同步。本文件只从
 * protocol.ts 引用 CLI 副本里也有的类型；依赖服务端补充形状（IssueV1 等）的组合类型在
 * protocol.phase1-iter2-server.ts（CLI 不复制）。
 * 只增不改：迭代 1 的类型保持不动，本轮需要更多字段的地方用 `…V2` 交叉类型表示；契约 §M 要求"追加"的枚举值
 * 写成单独的类型（InboxItemTypePhase1Iter2 等），与原联合类型合并使用，protocol.ts 里的原联合类型不改。
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

// ---------- 会话模式与任务来源（§A、§J） ----------

export type ExecutionMode = 'task' | 'session';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['task', 'session'];

/** 迭代 4 追加 `pm`：项目经理对话任务（docs/phase1/iteration-4-contract.md §C） */
export type IssueOriginType = 'manual' | 'intake' | 'agent' | 'pm';

/** 迭代 2 给任务追加的列 */
export interface IssuePhase2Fields {
  readonly executionMode: ExecutionMode;
  readonly originType: IssueOriginType;
  /** intake → 批次 id；agent → 创建它的运行 id；manual → null */
  readonly originId: string | null;
}

// ---------- GitHub 集成（§C） ----------

export interface GitConnectionView {
  readonly configured: boolean;
  readonly apiBaseUrl: string;
  readonly tokenSet: boolean;
  readonly webhookSecretSet: boolean;
  readonly webhookUrl: string;
  readonly lastEventAt: string | null;
}

/** 字段缺省 = 不变；空串 = 清除 */
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
  /** 服务端总是返回（关联时间）；CLI 不读取 */
  readonly linkedAt?: string;
}

export interface LinkPullRequestRequest {
  readonly url: string;
}

export interface UpdateIssuePullRequestRequest {
  readonly autoCompleteDisabled: boolean;
}

/** Agent 回写：POST /np/agent/issues/:id/pull-requests */
export interface AgentPullRequestLinkRequest {
  readonly url: string;
}

// ---------- 审批门禁（§D） ----------

/** @temporary(nocobase-official): 待替换为 NocoBase 官方 工作流审批（枚举值替换时不能改） */
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

/** `workflowTemplates.definition.transitions[].approval`（可选） */
export interface TransitionApproval {
  readonly approvers: readonly ApproverRole[];
}

export type WorkflowTransitionDefinitionV2 = WorkflowTransitionDefinition & {
  readonly approval?: TransitionApproval;
};

/** @temporary(nocobase-official): 待替换为 NocoBase 官方 工作流审批 */
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
 * `PATCH /np/issues/:id { statusKey }` 与 `POST /np/agent/issues/:id/status` 命中门禁时的 202 响应体 `data`：
 * 任务未变（整个 PATCH 不生效），审批请求已创建。
 */
export interface StatusChangePendingResponse {
  /** 未变的任务（服务端返回完整任务行 IssueV2，这里只列出 CLI 读取的字段） */
  readonly issue: IssueStatusSnapshot;
  readonly pendingApproval: ApprovalRequest;
}

/** 任务行里与状态相关的字段（完整行见服务端的 IssueV2） */
export type IssueStatusSnapshot = {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly statusKey: string;
  readonly revision: number;
} & IssuePhase2Fields;

// ---------- 表情与线程（§F） ----------

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

/** 评论行追加字段（浏览器详情里的 comments） */
export interface CommentV2 extends Comment {
  readonly reactions: readonly CommentReaction[];
  /** 只在线程根评论上有值 */
  readonly resolvedAt: string | null;
  readonly resolvedById: string | null;
  readonly resolvedByName: string | null;
}

/** Agent 视图的评论：`resolved` = 所在线程已解决 */
export interface CommentForAgentV2 extends CommentForAgent {
  readonly resolved: boolean;
}

// ---------- 环境变量（§G） ----------

export const AGENT_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
/** 保留名：`NOCOPROJECT_*` 前缀与这些名字（服务端 400 RESERVED_ENV_NAME；守护进程注入时跳过） */
export const RESERVED_ENV_NAMES: readonly string[] = ['PATH', 'HOME', 'SHELL'];
export const RESERVED_ENV_PREFIX = 'NOCOPROJECT_';
export const AGENT_ENV_MAX_VALUE_BYTES = 8 * 1024;
/** 守护进程只脱敏长度 ≥ 6 的值（避免把 `1` 之类全部替换） */
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

// ---------- 技能（§H） ----------

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
  /** 挂载了这个技能的 Agent 数 */
  readonly agentCount: number;
  /** 当前用户能否修改（创建者或 owner/admin） */
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

/** 认领载荷 `agent.skills[]` 的元素 */
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

// ---------- 批量录入（§E） ----------

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
  /** source = issue 时被拆分的任务 */
  readonly sourceIssueId: string | null;
  readonly rawContent: string;
  readonly parser: IntakeParserKind;
  readonly status: IntakeBatchStatus;
  readonly aiSessionId: string | null;
  readonly confirmedAt: string | null;
  /** AI 解析失败、回退启发式时的原因 */
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

export interface RevertIntakeResponse {
  readonly reverted: readonly string[];
  readonly kept: readonly string[];
}

// ---------- 用量与设置（§I） ----------

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
  /** 只在 totals 上：有价格的运行数 */
  readonly pricedRuns?: number;
}

export interface UsageResponse {
  readonly rows: readonly UsageRow[];
  readonly totals: UsageRow & { readonly pricedRuns: number };
}

export interface ModelPrice {
  readonly provider: string;
  /** glob，如 `claude-*` */
  readonly model: string;
  readonly inputPerM: number;
  readonly outputPerM: number;
  readonly cacheReadPerM: number;
  readonly cacheWritePerM: number;
}

export type IntakeParserSetting = 'auto' | 'heuristic';

/** `GET /np/settings`（systemSettings.settings，缺省键取默认值） */
export interface WorkspaceSettingsView {
  readonly autoExecuteSubtasksDefault: boolean;
  /** 状态键，或 `'none'` 表示 PR 合并后不改状态 */
  readonly prMergedStatus: string;
  readonly modelPrices: readonly ModelPrice[];
  readonly intakeParser: IntakeParserSetting;
  /** 只读：任务编号前缀 */
  readonly issuePrefix: string;
  /** 只读：当前用户能否修改（owner/admin） */
  readonly canEdit: boolean;
}

export interface UpdateWorkspaceSettingsRequest {
  readonly autoExecuteSubtasksDefault?: boolean;
  readonly prMergedStatus?: string;
  readonly modelPrices?: readonly ModelPrice[];
  readonly intakeParser?: IntakeParserSetting;
}

// ---------- 任务详情与运行（§C、§D、§F、§I、§J） ----------

/** 会话模式下排队中的那条运行（本轮结束后发送） */
export interface QueuedRunRef {
  readonly id: string;
  readonly triggerCount: number;
}

/** `GET /np/issues/:id/runs` 的完整响应体（`queuedRun` 与 `data` 同级） */
export interface IssueRunsResponse {
  readonly data: readonly RunSummary[];
  readonly queuedRun: QueuedRunRef | null;
}

// ---------- 认领载荷追加（§L） ----------

/** 认领载荷 `issue.pullRequests[]` 的元素 */
export interface ClaimedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState;
}

/** ClaimedRun 在迭代 2 追加的字段（服务端合并进 ClaimedRun；守护进程按可选读取） */
export interface ClaimedRunPhase2Extras {
  readonly agent: {
    /** 解密后的环境变量，只走守护进程路由 */
    readonly env: Readonly<Record<string, string>>;
    readonly skills: readonly ClaimedSkill[];
  };
  readonly issue: {
    readonly executionMode: ExecutionMode;
    readonly pullRequests: readonly ClaimedPullRequest[];
  };
}

// ---------- 追加的枚举值 ----------

export type InboxItemTypePhase1Iter2 =
  'approval_pending' | 'approval_decided' | 'pr_review' | 'pr_merged';
/** 迭代 1 与迭代 2 的全部收件箱类型 */
export type InboxItemTypeV2 = InboxItemType | InboxItemTypePhase1Iter2;
/** 收件箱项（`type` 含迭代 2 的类型） */
export type InboxItemV2 = Omit<InboxItem, 'type'> & {
  readonly type: InboxItemTypeV2;
};
export type RunFailureReasonPhase1Iter2 = 'blocked';
/** 运行的失败原因（含迭代 2 的 `blocked`：排队中的运行因新增阻塞依赖被撤回） */
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
