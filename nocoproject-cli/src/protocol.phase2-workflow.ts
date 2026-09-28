/**
 * NocoProject 协议类型：Phase 2 工作流阶段动作（NP-77 方案第 2 版 §1–§3、§5、§6；实现见
 * docs/phase2/protocol-workflow-stage-actions.md）。
 *
 * 服务端正本；CLI 用 `pnpm sync-protocol` 复制本文件。本文件只从 protocol.ts 与 protocol.phase1-iter*.ts 引用类型。
 * 只增不改：原联合类型保持不动，追加的枚举值写成单独的类型再合并。
 */
import type {
  AcceptAllProposalsResponse,
  AgentCreateIssueResponse,
  ExecutorProposal,
  ProposalStatus,
  StatusCategory,
  WorkflowDefinition,
  WorkflowStatusDefinition,
} from './protocol.js';
import type {
  InboxItemTypeV4,
  RunTriggerTypeV4,
  UpdateWorkspaceSettingsRequestV4,
  WorkspaceSettingsViewV4,
} from './protocol.phase1-iter4.js';

// ---------- 阶段动作（§1） ----------

export type StageActionType =
  | 'notifyOwner'
  | 'runExecutor'
  | 'suggestExecutor'
  | 'checklist'
  | 'requirePrMerged'
  | 'automation';

/** 进入条件（转换前检查，不通过则 409）；其余是进入效果（转换生效后执行） */
export const STAGE_GUARD_TYPES: readonly StageActionType[] = [
  'requirePrMerged',
];

export interface StageChecklistItemDefinition {
  /** `^[a-z0-9][a-z0-9_-]{0,63}$`，状态内唯一 */
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
}

export type StageAction =
  | { readonly type: 'notifyOwner'; readonly message?: string }
  | {
      readonly type: 'runExecutor';
      /** 空 = 当前 Agent 执行者；非空 = 进入该阶段由该 Agent 执行（设为执行者并创建运行） */
      readonly agentId?: string | null;
      /** 指令模板，只允许 STAGE_INSTRUCTION_VARIABLES 里的变量 */
      readonly instruction?: string;
    }
  | {
      readonly type: 'suggestExecutor';
      readonly agentId: string;
      readonly reason?: string;
    }
  | {
      readonly type: 'checklist';
      readonly items: readonly StageChecklistItemDefinition[];
    }
  | { readonly type: 'requirePrMerged'; readonly minCount?: number }
  /** 预留：交给 NocoBase 工作流插件执行的自动化脚本。本版校验拒绝，运行时跳过 */
  | { readonly type: 'automation'; readonly workflowKey: string };

export interface WorkflowStatusDefinitionV5 extends WorkflowStatusDefinition {
  readonly onEnter?: readonly StageAction[];
}

export interface WorkflowDefinitionV5 extends Omit<
  WorkflowDefinition,
  'statuses'
> {
  readonly statuses: readonly WorkflowStatusDefinitionV5[];
}

/** 指令模板可用的变量（`{{issue.identifier}}` 等，花括号内允许空白） */
export const STAGE_INSTRUCTION_VARIABLES = [
  'issue.identifier',
  'issue.title',
  'from',
  'to',
  'owner.name',
] as const;
export type StageInstructionVariable =
  (typeof STAGE_INSTRUCTION_VARIABLES)[number];

/** 定义校验的上限（§5） */
export const WORKFLOW_LIMITS = {
  statuses: 40,
  transitions: 200,
  actionsPerStatus: 10,
  checklistItems: 20,
  instructionLength: 4000,
  messageLength: 500,
  labelLength: 200,
  nameLength: 64,
  minCountMax: 20,
} as const;

/** 9 个内置状态（7 个核心 + 迭代 4 的 2 个设计先行状态）：不可删、key 与分类不可改 */
export const BUILTIN_STATUS_CATEGORIES: Readonly<
  Record<string, StatusCategory>
> = {
  backlog: 'unstarted',
  todo: 'unstarted',
  analysis: 'started',
  proposal_review: 'started',
  in_progress: 'started',
  in_review: 'started',
  blocked: 'started',
  done: 'done',
  cancelled: 'closed',
};

/** 定义校验的一条错误；`path` 形如 `statuses[3].onEnter[0].agentId` */
export interface WorkflowValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** 400 `INVALID_WORKFLOW` 的 `details` */
export interface WorkflowValidationDetails {
  readonly issues: readonly WorkflowValidationIssue[];
}

// ---------- 运行触发（§1、§2） ----------

/** 进入某阶段由 runExecutor 创建的运行 */
export type RunTriggerTypePhase2Workflow = 'stageEntered';
export type RunTriggerTypeV5 = RunTriggerTypeV4 | RunTriggerTypePhase2Workflow;

/** `stageEntered` 触发记录的 payload */
export interface StageEnteredPayload {
  readonly from: string;
  readonly to: string;
  /** 渲染后的阶段指令；没有指令模板时为 null */
  readonly instruction: string | null;
}

/** 认领载荷 `triggers[]` 追加：`stageEntered` 触发带上阶段与指令（守护进程按可选读取） */
export interface ClaimedTriggerPhase2Extras {
  readonly stage?: StageEnteredPayload;
}

/** 认领载荷 `issue` 追加：当前状态的检查清单（没有清单时为 null） */
export interface ClaimedRunWorkflowExtras {
  readonly issue: {
    readonly checklist: IssueChecklist | null;
  };
}

// ---------- 执行者建议（§3） ----------

export type ProposalSource = 'agent' | 'workflow';
/** 追加的建议状态：工作流建议在任务离开该状态时作废 */
export type ProposalStatusPhase2Workflow = 'superseded';
export type ProposalStatusV5 = ProposalStatus | ProposalStatusPhase2Workflow;

/** 建议追加的字段；`source = workflow` 时 `proposedByAgentId` 为 null */
export interface ExecutorProposalV5 extends Omit<
  ExecutorProposal,
  'status' | 'proposedByAgentId' | 'proposedByAgentName'
> {
  readonly status: ProposalStatusV5;
  readonly proposedByAgentId: string | null;
  readonly proposedByAgentName: string | null;
  readonly source: ProposalSource;
  /** 工作流建议：生成它的状态 */
  readonly stageStatusKey: string | null;
}

/** `POST /np/issues/:id/proposals/accept-all` 的 data（建议含 V5 字段） */
export type AcceptAllProposalsResponseV5 = Omit<
  AcceptAllProposalsResponse,
  'accepted'
> & { readonly accepted: readonly ExecutorProposalV5[] };

/** `POST /np/agent/issues` 的 data（建议含 V5 字段） */
export type AgentCreateIssueResponseV5 = Omit<
  AgentCreateIssueResponse,
  'proposal'
> & { readonly proposal: ExecutorProposalV5 | null };

// ---------- 检查清单（§6） ----------

export interface IssueChecklistItem {
  readonly itemKey: string;
  readonly label: string;
  readonly required: boolean;
  readonly checked: boolean;
  readonly checkedByType: 'user' | 'agent' | null;
  readonly checkedById: string | null;
  readonly checkedByName: string | null;
  readonly checkedAt: string | null;
}

/** 一个状态的清单快照（进入该状态时按定义生成） */
export interface IssueChecklist {
  readonly statusKey: string;
  /** 是任务当前所在状态 */
  readonly current: boolean;
  /** 必填项都已勾选 */
  readonly complete: boolean;
  readonly items: readonly IssueChecklistItem[];
}

/**
 * `GET /np/issues/:id/checklists`、`GET /np/agent/issues/:id/checklists` 的 data（当前状态在前，其余按生成时间）。
 * `PATCH /np/issues/:id/checklists/:statusKey/items/:itemKey`、`PATCH /np/agent/issues/:id/checklists/...`
 * 的请求体；响应 data 为该状态的 IssueChecklist。
 */
export interface UpdateChecklistItemRequest {
  readonly checked: boolean;
}

// ---------- 设置 ----------

/** 防循环：同一任务同一状态 `stageRunWindowHours` 小时内最多 `stageRunLimit` 次 runExecutor */
export interface WorkspaceSettingsPhase2WorkflowFields {
  readonly stageRunLimit: number;
  readonly stageRunWindowHours: number;
}
/** `GET/PATCH /np/settings`：追加防循环两项（owner/admin 可改：次数 1–100，窗口 1–720 小时） */
export type WorkspaceSettingsViewV5 = WorkspaceSettingsViewV4 &
  WorkspaceSettingsPhase2WorkflowFields;
export type UpdateWorkspaceSettingsRequestV5 =
  UpdateWorkspaceSettingsRequestV4 &
    Partial<WorkspaceSettingsPhase2WorkflowFields>;
export const DEFAULT_STAGE_RUN_LIMIT = 3;
export const DEFAULT_STAGE_RUN_WINDOW_HOURS = 24;

// ---------- 活动、收件箱、错误码 ----------

export type ActivityActionPhase2Workflow =
  | 'stage_action_applied'
  | 'stage_action_skipped'
  | 'stage_action_failed'
  | 'stage_action_suppressed'
  | 'checklist_item_checked'
  | 'checklist_item_unchecked'
  | 'approval_stale';

/** `stage_action_skipped` 的 `details.reason` */
export type StageActionSkipReason =
  | 'noAgentExecutor'
  | 'agentUnavailable'
  | 'noOwner'
  | 'ownerCannotInvoke'
  | 'selfTriggered'
  | 'alreadyExecutor'
  | 'duplicate'
  | 'notImplemented';

/**
 * `stage_entered`：notifyOwner（info，负责人）；`stage_action_problem`：阶段动作被跳过、失败或抑制（info，负责人）；
 * `approval_stale`：审批通过时进入条件已不满足，请求作废（info，审批人与请求人）
 */
export type InboxItemTypePhase2Workflow =
  'stage_entered' | 'stage_action_problem' | 'approval_stale';
export type InboxItemTypeV5 = InboxItemTypeV4 | InboxItemTypePhase2Workflow;

export const ERROR_STAGE_PR_NOT_MERGED = 'STAGE_PR_NOT_MERGED';
export const ERROR_CHECKLIST_INCOMPLETE = 'CHECKLIST_INCOMPLETE';
export const ERROR_INVALID_WORKFLOW = 'INVALID_WORKFLOW';
