/**
 * NocoProject protocol types: Phase 2 workflow template proposals (NP-77 plan v2 §4-§6, stage 2 /
 * NP-82; implementation in docs/phase2/protocol-workflow-proposals.md).
 *
 * Server source of truth; the CLI copies this file with `pnpm sync-protocol`. This file only imports
 * types from protocol.ts and the earlier protocol files.
 * Additive only: added enum values are written as separate types and then merged in.
 */
import type {
  InboxItemTypeV5,
  StageAction,
  WorkflowDefinitionV5,
} from './protocol.phase2-workflow.js';
import type { ActorType, Workflow } from './protocol.js';

// ---------- Templates (§4) ----------

/** The template of `GET /np/workflows[/:id]`, `GET /np/agent/workflows[/:id]`: adds the revision number and the system-template marker */
export type WorkflowV5 = Omit<Workflow, 'definition'> & {
  readonly definition: WorkflowDefinitionV5;
  /** Current revision number, starts at 1, +1 each time a change takes effect */
  readonly revision: number;
  /** A seed template (`default`, `software-with-approval`): can only be copied, not modified */
  readonly isSystem: boolean;
};

export type WorkflowListItemV5 = WorkflowV5 & {
  /** Number of projects using this template (the default template includes projects with no template specified) */
  readonly projectCount: number;
};

/** `GET /np/agent/workflows[/:id]`: adds whether the run's own project is using it */
export type AgentWorkflowListItem = WorkflowListItemV5 & {
  readonly usedByRunProject: boolean;
};

// ---------- Proposals (§4) ----------

export type WorkflowProposalKind = 'update' | 'copy';
/** `stale`: the template is no longer at the revision the proposal was based on by accept time, so the proposal becomes stale and must be resubmitted against the latest version */
export type WorkflowProposalStatus =
  'pending' | 'accepted' | 'rejected' | 'stale';

export const WORKFLOW_REASON_MAX = 500;
export const WORKFLOW_COMMENT_MAX = 2000;
export const WORKFLOW_TEMPLATE_NAME_MAX = 100;

/**
 * `POST /np/agent/workflows/proposals`: exactly one of `templateId` (modify an existing template) or
 * `copyFrom` (create a new one by copying); `name` is required when copying, optional when modifying
 * an existing one (renames it). `definition` is the entire new definition.
 */
export interface AgentWorkflowProposalRequest {
  readonly templateId?: string;
  readonly copyFrom?: string;
  readonly name?: string;
  readonly definition: unknown;
  readonly reason: string;
}

/** `POST /np/workflows/proposals/:id/accept|reject` (request body may be omitted) */
export interface DecideWorkflowProposalRequest {
  readonly comment?: string | null;
}

/** `PUT /np/workflows/:id` (owner/admin, no UI): `revision` is the revision it is based on (optimistic locking) */
export interface UpdateWorkflowRequest {
  readonly definition: unknown;
  readonly revision: number;
  readonly name?: string;
  /** A note recorded on the revision snapshot */
  readonly note?: string;
}

// ---------- Diff summary (§4) ----------

export interface WorkflowDiffStatus {
  readonly key: string;
  readonly name: string;
  readonly category: string;
}

export interface WorkflowDiffTransition {
  readonly from: string;
  readonly to: string;
  readonly actors: readonly string[];
  /** Approver roles; null when there is no approval */
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
    /** Name or color changes (key and category cannot change) */
    readonly changed: readonly {
      readonly key: string;
      readonly name?: WorkflowDiffChange<string>;
      readonly color?: WorkflowDiffChange<string>;
    }[];
    /** The order of statuses present on both sides changed (board column order) */
    readonly order?: WorkflowDiffChange<readonly string[]>;
  };
  /** Compared by `from → to` pair; multiple entries for the same pair are merged (actors take the union) */
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
  /** Additions and removals of each status's entry actions (compared as whole actions) */
  readonly actions: readonly {
    readonly statusKey: string;
    readonly added: readonly StageAction[];
    readonly removed: readonly StageAction[];
  }[];
  /**
   * Separately highlighted: every `runExecutor` with an `agentId` in the new definition (entering that
   * stage automatically wakes that agent, without the owner's confirmation).
   * `isNew`: the same status in the baseline has no runExecutor for this agent.
   */
  readonly runExecutorAgents: readonly {
    readonly statusKey: string;
    readonly agentId: string;
    readonly agentName: string | null;
    readonly isNew: boolean;
  }[];
  readonly childBatchDoneWakesParentExecutor?: WorkflowDiffChange<boolean>;
  /** Name change (a rename, or the new name after a copy) */
  readonly name?: WorkflowDiffChange<string>;
  /** Whether it is identical to the baseline */
  readonly empty: boolean;
}

/** `GET /np/workflows/proposals/:id`, and the response an agent submits */
export interface WorkflowProposal {
  readonly id: string;
  readonly kind: WorkflowProposalKind;
  /** For update: the target template; for copy: only present after accept (the new template's id) */
  readonly templateId: string | null;
  readonly templateName: string | null;
  readonly copyFromId: string | null;
  readonly copyFromName: string | null;
  /** The proposed name (required for copy; null for update means don't rename) */
  readonly name: string | null;
  readonly reason: string;
  /** The revision it is based on (for update: the target template; for copy: the source template) */
  readonly baseRevision: number;
  /** For update: the target template's current revision; null for copy */
  readonly currentRevision: number | null;
  /** Pending and the target template is no longer at `baseRevision`: accepting will get 409 `WORKFLOW_PROPOSAL_STALE` */
  readonly outdated: boolean;
  readonly definition: WorkflowDefinitionV5;
  /** The diff relative to `baseRevision` (for copy: relative to the source template) */
  readonly diff: WorkflowDiff;
  /** For update: number of projects using this template; 0 for copy */
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
  /** The revision number that took effect after accept */
  readonly resultRevision: number | null;
  /** Whether the caller can decide it (owner/admin, and it is still pending) */
  readonly canDecide: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Row of `GET /np/workflows/:id/revisions` (newest first) */
export interface WorkflowRevision {
  readonly revision: number;
  readonly name: string;
  readonly definition: WorkflowDefinitionV5;
  /** Produced by a proposal being accepted; null for an admin's direct write or the baseline snapshot before the first change */
  readonly proposalId: string | null;
  /** The proposal's reason, or the note an admin wrote; null for the baseline snapshot */
  readonly note: string | null;
  readonly createdByType: ActorType;
  readonly createdById: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string;
}

// ---------- Errors ----------

/** `details` of a 409 `WORKFLOW_STATUS_CONFLICT`: issues still exist in the deleted status, counted per project */
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
/** A system template can only be copied (`copyFrom`), not modified */
export const ERROR_WORKFLOW_SYSTEM_TEMPLATE = 'WORKFLOW_SYSTEM_TEMPLATE';

// ---------- Activity, inbox ----------

/**
 * `workflow_proposed` (on the source issue, from the agent) `{ proposalId, kind, templateId,
 * copyFromId, name }`;
 * `workflow_updated` (on the source issue, from the decider) `{ proposalId, kind, templateId, name,
 * revision }`
 */
export type ActivityActionPhase2WorkflowProposals =
  'workflow_proposed' | 'workflow_updated';

/**
 * `workflow_proposal`: a decision card, sent to every owner/admin (accept / reject);
 * `workflow_decided`: the result notification, sent to the source issue's owner (accepted / rejected /
 * stale)
 */
export type InboxItemTypePhase2WorkflowProposals =
  'workflow_proposal' | 'workflow_decided';
export type InboxItemTypeV6 =
  InboxItemTypeV5 | InboxItemTypePhase2WorkflowProposals;
