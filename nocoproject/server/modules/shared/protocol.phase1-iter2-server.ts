/**
 * NocoProject protocol types: Phase 1 iteration 2 server-only additional shapes
 * (docs/phase1/protocol-iteration-2.md).
 *
 * These types compose the iteration 1 types from protocol.ts's "response shapes added by the server
 * implementation" section (IssueV1, AgentListItemV1, etc.); the daemon does not use them and the CLI
 * does not copy them (the CLI's protocol.ts has no such section). The contract types are in
 * protocol.phase1-iter2.ts.
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

/** `POST /np/issues` adds `executionMode` (defaults to task) */
export type CreateIssueRequestV2 = CreateIssueRequestV1 & {
  readonly executionMode?: ExecutionMode;
};

/** The `GET/PATCH /np/agents` row adds `skillIds`, `skills` */
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
  /** Pending + the 5 most recently decided */
  readonly approvals: readonly ApprovalRequest[];
  /** Total usage across all of this issue's runs (key = issue id) */
  readonly usage: UsageRow;
  readonly queuedRun: QueuedRunRef | null;
}

/** Additions to the agent view */
export type IssueForAgentV2 = IssueForAgentV1 & {
  readonly executionMode: ExecutionMode;
  readonly pullRequests: readonly ClaimedPullRequest[];
};
