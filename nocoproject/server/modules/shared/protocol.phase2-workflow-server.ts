/**
 * NocoProject 协议类型：Phase 2 工作流阶段动作的服务端补充形状（docs/phase2/protocol-workflow-stage-actions.md）。
 *
 * 组合了迭代 4 的服务端类型，CLI 不复制。契约类型在 protocol.phase2-workflow.ts。
 */
import type { IssueDetailV4Paged } from './protocol.phase1-iter4-server.js';
import type { ExecutorProposalV5 } from './protocol.phase2-workflow.js';

/** `GET /np/issues/:id`：`proposals` 带 `source`、`stageStatusKey`，工作流建议没有提议 Agent */
export type IssueDetailV5Paged = Omit<IssueDetailV4Paged, 'proposals'> & {
  readonly proposals: readonly ExecutorProposalV5[];
};
