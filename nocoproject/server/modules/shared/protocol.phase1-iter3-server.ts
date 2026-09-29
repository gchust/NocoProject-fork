/**
 * NocoProject protocol types: Phase 1 iteration 3 server-only additional shapes
 * (docs/phase1/protocol-iteration-3.md).
 *
 * Composes the server-only types from protocol.phase1-iter2-server.ts; not copied by the CLI. The
 * contract types are in protocol.phase1-iter3.ts.
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

/** `GET /np/issues/:id`: activities include only the latest 50; comments include only the latest 200 when there are more than 200 */
export type IssueDetailV3 = IssueDetailV2 & IssueDetailPaging;

export type IssueListPageV3 = IssueListPage<IssueListItemV2>;
export type BoardGroupV3Server = BoardGroupV3<IssueListItemV2>;

/** The data of the delivery endpoint (full issue row) */
export interface DeliveryResultV3 {
  readonly issue: IssueV2;
  readonly pendingApproval: ApprovalRequest | null;
  readonly comment: CommentV2 | null;
}
