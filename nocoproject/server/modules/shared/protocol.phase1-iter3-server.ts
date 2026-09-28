/**
 * NocoProject 协议类型：Phase 1 迭代 3 的服务端补充形状（docs/phase1/protocol-iteration-3.md）。
 *
 * 组合了 protocol.phase1-iter2-server.ts 的服务端类型，CLI 不复制。契约类型在 protocol.phase1-iter3.ts。
 */
import type {
  IssueDetailV2,
  IssueListItemV2,
  IssueV2,
} from './protocol.phase1-iter2-server.js';
import type { ApprovalRequest, CommentV2 } from './protocol.phase1-iter2.js';
import type {
  BoardGroupV3,
  IssueDetailPaging,
  IssueListPage,
} from './protocol.phase1-iter3.js';

/** `GET /np/issues/:id`：活动只含最新 50 条，评论超过 200 条时只含最新 200 条 */
export type IssueDetailV3 = IssueDetailV2 & IssueDetailPaging;

export type IssueListPageV3 = IssueListPage<IssueListItemV2>;
export type BoardGroupV3Server = BoardGroupV3<IssueListItemV2>;

/** 交付接口的 data（完整任务行） */
export interface DeliveryResultV3 {
  readonly issue: IssueV2;
  readonly pendingApproval: ApprovalRequest | null;
  readonly comment: CommentV2 | null;
}
