/**
 * NocoProject protocol types: Phase 1 iteration 4 server-only additional shapes
 * (docs/phase1/protocol-iteration-4.md).
 *
 * Composes the server-only types from iterations 2 / 3; not copied by the CLI. The contract types are
 * in protocol.phase1-iter4.ts.
 */
import type {
  AgentListItemV2,
  CreateAgentRequestV2,
  CreateIssueRequestV2,
  IssueDetailV2,
  IssueForAgentV2,
  IssueListItemV2,
  IssueV2,
  UpdateAgentRequestV2,
  UpdateIssueRequestV2,
} from './protocol.phase1-iter2-server.js';
import type { IssueDetailPaging } from './protocol.phase1-iter3.js';
import type {
  AgentPhase4Fields,
  CreateIssueAttachmentFields,
  IssueForAgentAttachmentFields,
  AgentPhase4Input,
  DesignDecisionResult,
  DesignProposal,
  IssueForAgentPhase4Fields,
  IssuePhase4Fields,
  IssueProcess,
  PmIssueDetail,
} from './protocol.phase1-iter4.js';

export type IssueV4 = IssueV2 & IssuePhase4Fields;
export type IssueListItemV4 = IssueListItemV2 & IssuePhase4Fields;

/** `GET /np/issues/:id`: `issue` adds the latest proposal */
export interface IssueDetailV4 extends Omit<IssueDetailV2, 'issue'> {
  readonly issue: IssueListItemV4 & {
    readonly designProposal: DesignProposal | null;
  };
}
export type IssueDetailV4Paged = IssueDetailV4 & IssueDetailPaging;

export type CreateIssueRequestV4 = CreateIssueRequestV2 &
  CreateIssueAttachmentFields & {
    readonly process?: 'auto' | IssueProcess;
  };
export type UpdateIssueRequestV4 = UpdateIssueRequestV2 & {
  readonly process?: IssueProcess;
};

export type IssueForAgentV4 = IssueForAgentV2 &
  IssueForAgentPhase4Fields &
  IssueForAgentAttachmentFields;

export type AgentListItemV4 = AgentListItemV2 & AgentPhase4Fields;
export type CreateAgentRequestV4 = CreateAgentRequestV2 & AgentPhase4Input;
export type UpdateAgentRequestV4 = UpdateAgentRequestV2 & AgentPhase4Input;

export type DesignDecisionResultV4 = DesignDecisionResult<IssueV2>;
export type PmIssueDetailV4 = PmIssueDetail<IssueListItemV4>;
