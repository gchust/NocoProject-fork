/**
 * NocoProject 协议类型：Phase 1 迭代 4 追加（docs/phase1/iteration-4-contract.md，实现见
 * docs/phase1/protocol-iteration-4.md）。
 *
 * 服务端正本；CLI 用 `pnpm sync-protocol` 复制本文件。本文件只从 protocol.ts、protocol.phase1-iter2.ts 与
 * protocol.phase1-iter3.ts 引用类型；依赖服务端补充形状（IssueV2、IssueDetailV3 等）的组合类型在
 * protocol.phase1-iter4-server.ts（CLI 不复制）。
 * 只增不改：原联合类型保持不动，追加的枚举值写成单独的类型（InboxItemTypePhase1Iter4 等）再合并。唯一例外是
 * protocol.phase1-iter2.ts 的 `IssueOriginType` 追加了 `'pm'`（契约 §C "originType 增加 pm"）。
 */
import type {
  Activity,
  CommentKind,
  Phase1RunTriggerType,
  ProjectListItem,
  RunSummary,
  SubtaskSummary,
  TriggeredRun,
} from './protocol.js';
import type {
  CommentV2,
  CreateIntakeBatchRequest,
  IntakeDraftFields,
  IssuePullRequestView,
  IssueStatusSnapshot,
  UsageRow,
} from './protocol.phase1-iter2.js';
import type {
  InboxAction,
  InboxItemTypeV3,
  InboxItemV3,
  IssueListRow,
  UpdateWorkspaceSettingsRequestV3,
  WorkspaceSettingsViewV3,
} from './protocol.phase1-iter3.js';

// ---------- 设计先行（§B） ----------

/** `issues.process` */
export type IssueProcess = 'direct' | 'design_first';
export const ISSUE_PROCESSES: readonly IssueProcess[] = [
  'direct',
  'design_first',
];
/** 建任务 / 批量录入的 `process`，也是 `settings.defaultProcess`：`auto` = 服务端分类 */
export type DefaultProcess = 'auto' | IssueProcess;
export const DEFAULT_PROCESSES: readonly DefaultProcess[] = [
  'auto',
  'direct',
  'design_first',
];
/** `process_selected` 活动的 `details.by` */
export type ProcessSelectedBy = 'user' | 'heuristic' | 'ai';

/** 设计先行的两个内置状态（category started，依次在 todo 之后） */
export const STATUS_ANALYSIS = 'analysis';
export const STATUS_PROPOSAL_REVIEW = 'proposal_review';
/** `PATCH /np/issues/:id { process }` 只在这些状态下允许（否则 409 PROCESS_LOCKED） */
export const PROCESS_EDITABLE_STATUSES: readonly string[] = ['backlog', 'todo'];

/** 迭代 4 给任务追加的列 */
export interface IssuePhase4Fields {
  readonly process: IssueProcess;
  readonly designApprovedAt: string | null;
  readonly designApprovedById: string | null;
}

/** `POST /np/issues`、`PATCH /np/issues/:id` 追加（PATCH 不接受 `auto`） */
export interface IssuePhase4Input {
  readonly process?: DefaultProcess;
}

/** `comments.kind` 追加的值：设计方案 */
export type CommentKindPhase1Iter4 = 'proposal';
export type CommentKindV4 = CommentKind | CommentKindPhase1Iter4;

/** `POST /np/agent/issues/:id/design-proposal`；响应 201 `{ data: CommentV2 }`（kind = 'proposal' 的顶层评论） */
export interface AgentDesignProposalRequest {
  readonly content: string;
}
export const DESIGN_PROPOSAL_MAX = 200_000;

/** 最新的设计方案（kind = 'proposal' 的最新评论）：认领载荷 `issue.designProposal`、任务详情 `issue.designProposal` */
export interface DesignProposal {
  readonly commentId: string;
  /** Markdown：需求理解 / 方案 / 影响范围 / 风险与待定 / 验证计划 */
  readonly content: string;
  readonly createdAt: string;
}

/** `POST /np/issues/:id/design/approve`（body 可省略） */
export interface DesignApproveRequest {
  readonly comment?: string;
}

/** `POST /np/issues/:id/design/request-changes` */
export interface DesignRequestChangesRequest {
  readonly comment: string;
}

/** 两个设计决定接口的 data；`issue` 是完整任务行（服务端 IssueV4），这里只列 CLI 读取的字段 */
export interface DesignDecisionResult<TIssue = IssueStatusSnapshot> {
  readonly issue: TIssue & IssuePhase4Fields;
  readonly comment: CommentV2 | null;
  readonly triggered: readonly TriggeredRun[];
}

/** `design_review` 决定项的 payload（另有 identifier、issueTitle、actions） */
export interface DesignReviewPayload {
  readonly proposalCommentId: string | null;
  /** 方案正文前 300 字 */
  readonly summary: string;
  readonly from: string | null;
}
export const DESIGN_REVIEW_SUMMARY_LENGTH = 300;

// ---------- Agent 类型与推理强度（§C） ----------

export type AgentKind = 'coder' | 'manager';
export const AGENT_KINDS: readonly AgentKind[] = ['coder', 'manager'];
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'max',
];

/** 迭代 4 给 Agent 追加的列（`GET /np/agents` 的行） */
export interface AgentPhase4Fields {
  readonly kind: AgentKind;
  readonly reasoningEffort: ReasoningEffort | null;
}

/** `POST /np/agents`、`PATCH /np/agents/:id` 追加 */
export interface AgentPhase4Input {
  readonly kind?: AgentKind;
  readonly reasoningEffort?: ReasoningEffort | null;
}

// ---------- 运行触发与认领载荷（§B、§C） ----------

/** 迭代 4 新增的触发类型：方案批准后的实现运行、任务完成后的总结运行 */
export type RunTriggerTypePhase1Iter4 = 'designApproved' | 'retrospective';
export type RunTriggerTypeV4 = Phase1RunTriggerType | RunTriggerTypePhase1Iter4;
/** 总结运行的 threadScope */
export const RETROSPECTIVE_THREAD_SCOPE = 'retro';

/** ClaimedRun 在迭代 4 追加的字段（守护进程按可选读取） */
export interface ClaimedRunPhase4Extras {
  readonly agent: {
    readonly kind: AgentKind;
    readonly reasoningEffort: ReasoningEffort | null;
  };
  readonly issue: {
    readonly process: IssueProcess;
    readonly designApprovedAt: string | null;
    /** 最新方案；没有方案时为 null */
    readonly designProposal: DesignProposal | null;
    /** `'pm'` = 项目经理对话任务 */
    readonly originType: string;
  };
}

/** Agent 任务视图（`GET /np/agent/issues/:id`、`/context`）追加 */
export interface IssueForAgentPhase4Fields {
  readonly process: IssueProcess;
  readonly designApprovedAt: string | null;
}

// ---------- 项目经理（§C） ----------

/** `GET/POST /np/pm/conversation` 的 data */
export interface PmConversationResponse {
  readonly issueId: string;
  readonly identifier: string;
  /** 当前执行者（= settings.pmAgentId） */
  readonly agentId: string | null;
}

/** `GET /np/agent/pm/issues` 的查询参数 */
export interface PmIssueListQuery {
  readonly projectId?: string;
  readonly statusKey?: string;
  /** 用户 id；`me` = 运行的 actorUserId（提问者） */
  readonly ownerUserId?: string;
  readonly executorId?: string;
  readonly q?: string;
  /** ISO 时间，或相对时长 `7d` / `24h` / `30m` */
  readonly updatedSince?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export type PmIssueRow = IssueListRow & IssuePhase4Fields;

/** `GET /np/agent/pm/issues` 的完整响应体（`nextCursor` 与 `data` 同级） */
export interface PmIssueListPage<T = PmIssueRow> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

/** `GET /np/agent/pm/issues/:idOrIdentifier` 的 data */
export interface PmIssueDetail<T = PmIssueRow> {
  readonly issue: T & { readonly designProposal: DesignProposal | null };
  /** 最近 50 条（升序） */
  readonly comments: readonly CommentV2[];
  /** 最近 50 条（升序） */
  readonly activities: readonly Activity[];
  readonly runs: readonly RunSummary[];
  readonly pullRequests: readonly IssuePullRequestView[];
  readonly subtasks: readonly SubtaskSummary[];
  /** 该任务所有运行的用量合计 */
  readonly usage: UsageRow;
}

/** `GET /np/agent/pm/projects` 的 data */
export type PmProjectList = readonly ProjectListItem[];

/** PM 详情里评论 / 活动的条数 */
export const PM_DETAIL_TAIL = 50;

// ---------- 设置（§A） ----------

export interface WorkspaceSettingsPhase4Fields {
  readonly defaultProcess: DefaultProcess;
  readonly pmAgentId: string | null;
  readonly retrospectiveOnDone: boolean;
}

export type WorkspaceSettingsViewV4 = WorkspaceSettingsViewV3 &
  WorkspaceSettingsPhase4Fields;

export type UpdateWorkspaceSettingsRequestV4 =
  UpdateWorkspaceSettingsRequestV3 & Partial<WorkspaceSettingsPhase4Fields>;

// ---------- 批量录入（§D） ----------

/** 草稿字段追加 `process`（缺省 = settings.defaultProcess；auto 在确认时用启发式分类） */
export type IntakeDraftFieldsV4 = IntakeDraftFields & {
  readonly process?: DefaultProcess;
  /** NP-78：确认时挂到这条草稿建出的任务的批次附件 */
  readonly attachmentIds?: readonly string[];
};

/** `POST /np/intake/batches` 追加 `process`：写进每条没有 `process` 的草稿 */
export type CreateIntakeBatchRequestV4 = CreateIntakeBatchRequest & {
  readonly process?: DefaultProcess;
  /** NP-78：见 `IntakeBatchAttachment` */
  readonly attachmentIds?: readonly string[];
};

// ---------- 在任务页与收件箱合并 PR（NP-85） ----------

/**
 * 不能合并的原因。`closed` / `merged` / `draft`：PR 状态；`conflicts`：GitHub `mergeable === false` 或
 * `mergeable_state = dirty`；`computing`：`mergeable === null`（GitHub 还在计算）；`ciPending` / `ciFailed` /
 * `ciMissing`：提交的检查运行中 / 失败 / 一个都没有；`notConfigured`：没有保存 GitHub 令牌；`protected`：GitHub
 * 拒绝合并（分支保护要求评审或分支最新，只在合并时出现）。
 */
export type PullRequestMergeBlocker =
  | 'closed'
  | 'merged'
  | 'draft'
  | 'conflicts'
  | 'computing'
  | 'ciPending'
  | 'ciFailed'
  | 'ciMissing'
  | 'notConfigured'
  | 'protected';

/** 合并后任务为什么不变：设置为不改 / 还有未合并的 PR / 本 PR 关闭了自动完成 / 任务已是终态 */
export type PullRequestMergeKeepReason =
  'setting' | 'otherPrs' | 'optedOut' | 'terminal';

/** 合并后任务会怎样：`statusKey` 非空时改为该状态，否则按 `keepReason` 不变 */
export interface PullRequestMergeOutcome {
  readonly statusKey: string | null;
  readonly statusName: string | null;
  readonly keepReason: PullRequestMergeKeepReason | null;
}

/** `GET /np/issues/:id/pull-requests/:prId/merge` 的 data（取自 GitHub 最新状态） */
export interface PullRequestMergePreflight {
  readonly blocker: PullRequestMergeBlocker | null;
  readonly method: 'squash';
  readonly headSha: string;
  readonly baseRef: string;
  /** `<PR 标题> (#<编号>)` */
  readonly commitTitle: string;
  readonly statusAfter: PullRequestMergeOutcome;
}

/** `POST /np/issues/:id/pull-requests/:prId/merge` */
export interface MergePullRequestRequest {
  /** 确认框里看到的 head；与 GitHub 最新 head 不一致时 409 PR_CHANGED */
  readonly expectedHeadSha: string;
}

export interface MergePullRequestResponse {
  readonly merged: true;
  readonly sha: string;
}

/** PR 列表 / 任务详情 `pullRequests[]` 每项追加的字段 */
export interface IssuePullRequestPhase4Fields {
  /** 当前用户能否合并（任务负责人、项目负责人、owner/admin） */
  readonly viewerCanMerge: boolean;
  /** head 提交最新一次 GitHub Actions 运行 */
  readonly ciRunUrl: string | null;
  /** 该运行的 `screenshots` artifact（网页地址，登录 GitHub 后下载） */
  readonly screenshotsUrl: string | null;
}

export type IssuePullRequestViewV4 = IssuePullRequestView &
  IssuePullRequestPhase4Fields;

/** 收件箱动作追加：`confirm` = 先打开确认框（`prMerge`：合并确认框），`disabledReason` = 置灰并说明原因 */
export type InboxActionV4 = InboxAction & {
  readonly confirm?: 'prMerge';
  readonly disabledReason?: PullRequestMergeBlocker;
  /** `confirm: 'prMerge'` 时：要合并的 PR */
  readonly pullRequestId?: string;
};
// ---------- 任务附件（NP-78） ----------

/**
 * `GET /np/issues/:id/attachments` 的一项。文件本身由 `POST /api/npFiles:uploadOne`（multipart，字段名 `file`，每次一个）上传，
 * 上传后未挂任务，只有上传者可见；`contentUrl`（`/uploads/np/<uuid>.<ext>`，含应用前缀）按所属任务的可见性鉴权。
 */
export interface IssueAttachment {
  readonly id: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentUrl: string;
  readonly uploadedById: string | null;
  readonly uploadedByName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 调用者可以移除（上传者、任务负责人、项目负责人、owner/admin） */
  readonly canDelete: boolean;
}

/** `POST /np/issues/:id/attachments`：只能挂调用者自己上传、尚未挂任务的文件 */
export interface AttachFilesRequest {
  readonly fileIds: readonly string[];
}

/** `POST /np/issues` 追加：建任务时一并挂上的文件（同上规则） */
export interface CreateIssueAttachmentFields {
  readonly attachmentIds?: readonly string[];
}

/** Agent 读任务时看到的附件元数据（本期不提供内容下载） */
export interface AgentAttachmentInfo {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}
export interface IssueForAgentAttachmentFields {
  readonly attachments: readonly AgentAttachmentInfo[];
}

/**
 * AI 整理（批量录入）带附件：`POST /np/intake/batches` 追加 `attachmentIds`（调用者自己上传、未挂任务、未进其它批次），
 * 文件跟着批次走；解析出的第一条顶层草稿的 `fields.attachmentIds` 先拿到全部文件，可以在草稿之间移动。确认时每个文件挂到
 * 它所在草稿建出的任务；不在任何草稿里的文件挂到第一个建出的任务。
 *
 * 批次详情（`GET /np/intake/batches/:id`、创建的响应）追加 `attachments`，每项如下。
 */
export interface IntakeBatchAttachment {
  readonly id: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentUrl: string;
  /** 已挂到的任务（批次确认后） */
  readonly issueId: string | null;
  /** AI 整理读取这个文件的结果（批次创建时写入；旧批次为 null） */
  readonly readStatus: IntakeAttachmentReadStatus | null;
}

/**
 * AI 整理读附件的结果：`read` 已读、`truncated` 已读但截断、`empty` 没读到文字（如扫描版 PDF）、`unsupported`
 * 不支持的格式（图片等，只把文件名给模型）、`legacy` 老 Office 格式（doc / xls / ppt）、`failed` 读取失败、
 * `skipped` 合计字数已满未读。
 */
export type AttachmentReadState =
  | 'read'
  | 'truncated'
  | 'empty'
  | 'unsupported'
  | 'legacy'
  | 'failed'
  | 'skipped';
export interface IntakeAttachmentReadStatus {
  readonly state: AttachmentReadState;
  /** 交给模型的字数 */
  readonly chars: number;
}
export interface IntakeBatchAttachmentsField {
  readonly attachments: readonly IntakeBatchAttachment[];
}

/** 单次最多挂的文件数 */
export const MAX_ATTACHMENTS_PER_REQUEST = 10;

// ---------- 追加的枚举值 ----------

export type InboxItemTypePhase1Iter4 = 'design_review';
/** 迭代 1–4 的全部收件箱类型 */
export type InboxItemTypeV4 = InboxItemTypeV3 | InboxItemTypePhase1Iter4;
export type InboxItemV4 = Omit<InboxItemV3, 'type'> & {
  readonly type: InboxItemTypeV4;
};
export type ActivityActionPhase1Iter4 =
  | 'process_selected'
  | 'design_skipped'
  | 'design_proposed'
  | 'design_approved'
  | 'design_changes_requested'
  | 'retrospective_done'
  | 'pr_merge_requested'
  | 'attachment_added'
  | 'attachment_removed';

// ---------- 错误码 ----------

export const ERROR_PROCESS_LOCKED = 'PROCESS_LOCKED';
export const ERROR_DESIGN_NOT_APPROVED = 'DESIGN_NOT_APPROVED';
export const ERROR_PROPOSAL_REQUIRED = 'PROPOSAL_REQUIRED';
export const ERROR_NOT_DESIGN_FIRST = 'NOT_DESIGN_FIRST';
export const ERROR_DESIGN_ALREADY_APPROVED = 'DESIGN_ALREADY_APPROVED';
export const ERROR_MANAGER_NOT_EXECUTOR = 'MANAGER_NOT_EXECUTOR';
export const ERROR_MANAGER_ONLY = 'MANAGER_ONLY';
export const ERROR_PM_NOT_CONFIGURED = 'PM_NOT_CONFIGURED';
/** 409：PR 当前不能合并（`details.blocker`） */
export const ERROR_PR_NOT_MERGEABLE = 'PR_NOT_MERGEABLE';
/** 409：确认之后 PR 有了新提交 */
export const ERROR_PR_CHANGED = 'PR_CHANGED';
/** 409：令牌缺少 Contents 与 Pull requests 的写权限 */
export const ERROR_GITHUB_MERGE_FORBIDDEN = 'GITHUB_MERGE_FORBIDDEN';
export const ERROR_INVALID_ATTACHMENT = 'INVALID_ATTACHMENT';
