/**
 * NocoProject 协议类型：Phase 1 迭代 2 的服务端补充形状（docs/phase1/protocol-iteration-2.md）。
 *
 * 这些类型组合了 protocol.ts "服务端实现补充的响应形状" 段里的迭代 1 类型（IssueV1、AgentListItemV1 等），守护进程
 * 不使用，CLI 不复制（CLI 的 protocol.ts 没有那一段）。契约类型在 protocol.phase1-iter2.ts。
 */
import type {
  AgentListItemV1,
  CreateAgentRequestV1,
  IssueDetailV1,
  IssueForAgentV1,
  IssueListItemV1,
  IssueV1,
  UpdateAgentRequestV1,
  CreateIssueRequestV1,
  UpdateIssueRequestV1,
} from './protocol.js';
import type {
  ApprovalRequest,
  ClaimedPullRequest,
  CommentV2,
  ExecutionMode,
  IssuePhase2Fields,
  IssuePullRequestView,
  QueuedRunRef,
  SkillRef,
  UsageRow,
} from './protocol.phase1-iter2.js';

export type IssueV2 = IssueV1 & IssuePhase2Fields;
export type IssueListItemV2 = IssueListItemV1 & IssuePhase2Fields;

export type UpdateIssueRequestV2 = UpdateIssueRequestV1 & {
  readonly executionMode?: ExecutionMode;
};

/** `POST /np/issues` 追加 `executionMode`（默认 task） */
export type CreateIssueRequestV2 = CreateIssueRequestV1 & {
  readonly executionMode?: ExecutionMode;
};

/** `GET/PATCH /np/agents` 的行追加 `skillIds`、`skills` */
export type AgentListItemV2 = AgentListItemV1 & {
  readonly skillIds: readonly string[];
  readonly skills: readonly SkillRef[];
};

export type CreateAgentRequestV2 = CreateAgentRequestV1 & {
  readonly skillIds?: readonly string[];
};

export type UpdateAgentRequestV2 = UpdateAgentRequestV1 & {
  readonly skillIds?: readonly string[];
};

export interface IssueDetailV2 extends Omit<
  IssueDetailV1,
  'issue' | 'comments'
> {
  readonly issue: IssueListItemV2;
  readonly comments: readonly CommentV2[];
  readonly pullRequests: readonly IssuePullRequestView[];
  /** 未决 + 最近 5 条已决 */
  readonly approvals: readonly ApprovalRequest[];
  /** 该任务所有运行的用量合计（key = 任务 id） */
  readonly usage: UsageRow;
  readonly queuedRun: QueuedRunRef | null;
}

/** Agent 视图追加 */
export type IssueForAgentV2 = IssueForAgentV1 & {
  readonly executionMode: ExecutionMode;
  readonly pullRequests: readonly ClaimedPullRequest[];
};
