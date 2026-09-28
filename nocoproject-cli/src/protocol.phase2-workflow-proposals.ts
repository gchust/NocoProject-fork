/**
 * NocoProject 协议类型：Phase 2 工作流模板提议（NP-77 方案第 2 版 §4–§6，stage 2 / NP-82；实现见
 * docs/phase2/protocol-workflow-proposals.md）。
 *
 * 服务端正本；CLI 用 `pnpm sync-protocol` 复制本文件。本文件只从 protocol.ts 与更早的协议文件引用类型。
 * 只增不改：追加的枚举值写成单独的类型再合并。
 */
import type {
  InboxItemTypeV5,
  StageAction,
  WorkflowDefinitionV5,
} from './protocol.phase2-workflow.js';
import type { ActorType, Workflow } from './protocol.js';

// ---------- 模板（§4） ----------

/** `GET /np/workflows[/:id]`、`GET /np/agent/workflows[/:id]` 的模板：追加修订号与系统模板标记 */
export type WorkflowV5 = Omit<Workflow, 'definition'> & {
  readonly definition: WorkflowDefinitionV5;
  /** 当前修订号，从 1 开始；每次生效 + 1 */
  readonly revision: number;
  /** 种子模板（`default`、`software-with-approval`）：只能复制，不能改 */
  readonly isSystem: boolean;
};

export type WorkflowListItemV5 = WorkflowV5 & {
  /** 使用这个模板的项目数（默认模板含未指定模板的项目） */
  readonly projectCount: number;
};

/** `GET /np/agent/workflows[/:id]`：追加“运行所在项目正在用它” */
export type AgentWorkflowListItem = WorkflowListItemV5 & {
  readonly usedByRunProject: boolean;
};

// ---------- 提议（§4） ----------

export type WorkflowProposalKind = 'update' | 'copy';
/** `stale`：接受时模板已不是提议所基于的修订，提议作废，需基于最新版重提 */
export type WorkflowProposalStatus =
  'pending' | 'accepted' | 'rejected' | 'stale';

export const WORKFLOW_REASON_MAX = 500;
export const WORKFLOW_COMMENT_MAX = 2000;
export const WORKFLOW_TEMPLATE_NAME_MAX = 100;

/**
 * `POST /np/agent/workflows/proposals`：`templateId`（改现有模板）与 `copyFrom`（复制后新建）二选一；
 * `name` 复制时必填，改现有时可选（改名）。`definition` 是整份新定义。
 */
export interface AgentWorkflowProposalRequest {
  readonly templateId?: string;
  readonly copyFrom?: string;
  readonly name?: string;
  readonly definition: unknown;
  readonly reason: string;
}

/** `POST /np/workflows/proposals/:id/accept|reject`（请求体可省略） */
export interface DecideWorkflowProposalRequest {
  readonly comment?: string | null;
}

/** `PUT /np/workflows/:id`（owner/admin，无界面）：`revision` 是所基于的修订（乐观锁） */
export interface UpdateWorkflowRequest {
  readonly definition: unknown;
  readonly revision: number;
  readonly name?: string;
  /** 记在修订快照上的说明 */
  readonly note?: string;
}

// ---------- 差异摘要（§4） ----------

export interface WorkflowDiffStatus {
  readonly key: string;
  readonly name: string;
  readonly category: string;
}

export interface WorkflowDiffTransition {
  readonly from: string;
  readonly to: string;
  readonly actors: readonly string[];
  /** 审批人角色；没有审批为 null */
  readonly approvers: readonly string[] | null;
}

export interface WorkflowDiffChange<T> {
  readonly from: T;
  readonly to: T;
}

export interface WorkflowDiff {
  readonly statuses: {
    readonly added: readonly WorkflowDiffStatus[];
    readonly removed: readonly WorkflowDiffStatus[];
    /** 名称或颜色变化（key 与分类不可改） */
    readonly changed: readonly {
      readonly key: string;
      readonly name?: WorkflowDiffChange<string>;
      readonly color?: WorkflowDiffChange<string>;
    }[];
    /** 两边都有的状态顺序变了（看板列顺序） */
    readonly order?: WorkflowDiffChange<readonly string[]>;
  };
  /** 按 `from → to` 对比；同一对的多条合并（角色取并集） */
  readonly transitions: {
    readonly added: readonly WorkflowDiffTransition[];
    readonly removed: readonly WorkflowDiffTransition[];
    readonly changed: readonly {
      readonly from: string;
      readonly to: string;
      readonly actors?: WorkflowDiffChange<readonly string[]>;
      readonly approvers?: WorkflowDiffChange<readonly string[] | null>;
    }[];
  };
  /** 每个状态的进入动作增删（整条动作对比） */
  readonly actions: readonly {
    readonly statusKey: string;
    readonly added: readonly StageAction[];
    readonly removed: readonly StageAction[];
  }[];
  /**
   * 单独高亮：新定义里所有带 `agentId` 的 `runExecutor`（进入该阶段自动唤醒该 Agent，免负责人确认）。
   * `isNew`：基准里同一状态没有这个 Agent 的 runExecutor。
   */
  readonly runExecutorAgents: readonly {
    readonly statusKey: string;
    readonly agentId: string;
    readonly agentName: string | null;
    readonly isNew: boolean;
  }[];
  readonly childBatchDoneWakesParentExecutor?: WorkflowDiffChange<boolean>;
  /** 名称变化（改名或复制后的新名） */
  readonly name?: WorkflowDiffChange<string>;
  /** 与基准完全相同 */
  readonly empty: boolean;
}

/** `GET /np/workflows/proposals/:id`、Agent 提交的响应 */
export interface WorkflowProposal {
  readonly id: string;
  readonly kind: WorkflowProposalKind;
  /** 改现有：目标模板；复制：接受后才有（新模板 id） */
  readonly templateId: string | null;
  readonly templateName: string | null;
  readonly copyFromId: string | null;
  readonly copyFromName: string | null;
  /** 提议的名称（复制必有；改现有时为 null 表示不改名） */
  readonly name: string | null;
  readonly reason: string;
  /** 所基于的修订（改现有：目标模板；复制：来源模板） */
  readonly baseRevision: number;
  /** 改现有：目标模板当前修订；复制为 null */
  readonly currentRevision: number | null;
  /** 待定且目标模板已不是 `baseRevision`：接受会得到 409 `WORKFLOW_PROPOSAL_STALE` */
  readonly outdated: boolean;
  readonly definition: WorkflowDefinitionV5;
  /** 相对 `baseRevision` 的定义（复制：来源模板） */
  readonly diff: WorkflowDiff;
  /** 改现有：使用该模板的项目数；复制为 0 */
  readonly affectedProjectCount: number;
  readonly proposedByAgentId: string;
  readonly proposedByAgentName: string | null;
  readonly sourceRunId: string | null;
  readonly sourceIssueId: string | null;
  readonly sourceIssueIdentifier: string | null;
  readonly status: WorkflowProposalStatus;
  readonly decidedById: string | null;
  readonly decidedByName: string | null;
  readonly decidedAt: string | null;
  readonly comment: string | null;
  /** 接受后生效的修订号 */
  readonly resultRevision: number | null;
  /** 调用者可以决定（owner/admin，且仍待定） */
  readonly canDecide: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `GET /np/workflows/:id/revisions` 的行（新在前） */
export interface WorkflowRevision {
  readonly revision: number;
  readonly name: string;
  readonly definition: WorkflowDefinitionV5;
  /** 由提议接受产生；管理员直接写或首次修改前的基线快照为 null */
  readonly proposalId: string | null;
  /** 提议的理由或管理员写入的说明；基线快照为 null */
  readonly note: string | null;
  readonly createdByType: ActorType;
  readonly createdById: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string;
}

// ---------- 错误 ----------

/** 409 `WORKFLOW_STATUS_CONFLICT` 的 `details`：删除的状态上还有任务，按项目计数 */
export interface WorkflowStatusConflictDetails {
  readonly statuses: readonly {
    readonly statusKey: string;
    readonly total: number;
    readonly projects: readonly {
      readonly projectId: string;
      readonly projectName: string;
      readonly count: number;
    }[];
  }[];
}

export const ERROR_WORKFLOW_STATUS_CONFLICT = 'WORKFLOW_STATUS_CONFLICT';
export const ERROR_WORKFLOW_PROPOSAL_PENDING = 'WORKFLOW_PROPOSAL_PENDING';
export const ERROR_WORKFLOW_PROPOSAL_STALE = 'WORKFLOW_PROPOSAL_STALE';
export const ERROR_WORKFLOW_PROPOSAL_DECIDED = 'WORKFLOW_PROPOSAL_DECIDED';
/** 系统模板只能复制（`copyFrom`），不能改 */
export const ERROR_WORKFLOW_SYSTEM_TEMPLATE = 'WORKFLOW_SYSTEM_TEMPLATE';

// ---------- 活动、收件箱 ----------

/**
 * `workflow_proposed`（来源任务，Agent）`{ proposalId, kind, templateId, copyFromId, name }`；
 * `workflow_updated`（来源任务，决定人）`{ proposalId, kind, templateId, name, revision }`
 */
export type ActivityActionPhase2WorkflowProposals =
  'workflow_proposed' | 'workflow_updated';

/**
 * `workflow_proposal`：决定卡，发给每个 owner/admin（accept / reject）；
 * `workflow_decided`：结果通知，发给来源任务负责人（accepted / rejected / stale）
 */
export type InboxItemTypePhase2WorkflowProposals =
  'workflow_proposal' | 'workflow_decided';
export type InboxItemTypeV6 =
  InboxItemTypeV5 | InboxItemTypePhase2WorkflowProposals;
