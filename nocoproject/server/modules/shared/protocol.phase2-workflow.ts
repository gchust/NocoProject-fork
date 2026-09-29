/**
 * NocoProject protocol types: Phase 2 workflow stage actions (NP-77 plan v2 §1-§3, §5, §6;
 * implementation in docs/phase2/protocol-workflow-stage-actions.md).
 *
 * Server source of truth; the CLI copies this file with `pnpm sync-protocol`. This file only imports
 * types from protocol.ts and protocol.phase1-iter*.ts.
 * Additive only: the original union types stay unchanged, and added enum values are written as
 * separate types and then merged in.
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

// ---------- Stage actions (§1) ----------

export type StageActionType =
  | 'notifyOwner'
  | 'runExecutor'
  | 'suggestExecutor'
  | 'checklist'
  | 'requirePrMerged'
  | 'automation';

/** Entry conditions (checked before the transition, 409 if not met); the rest are entry effects (run after the transition takes effect) */
export const STAGE_GUARD_TYPES: readonly StageActionType[] = [
  'requirePrMerged',
];

export interface StageChecklistItemDefinition {
  /** `^[a-z0-9][a-z0-9_-]{0,63}$`, unique within the status */
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
}

export type StageAction =
  | { readonly type: 'notifyOwner'; readonly message?: string }
  | {
      readonly type: 'runExecutor';
      /** Empty = the current agent executor; non-empty = entering this stage is executed by this agent (set as executor and a run created) */
      readonly agentId?: string | null;
      /** An instruction template; only variables from STAGE_INSTRUCTION_VARIABLES are allowed */
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
  /** Reserved: an automation script handed to the NocoBase workflow plugin to run. Rejected by validation in this version, skipped at runtime */
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

/** Variables available in the instruction template (`{{issue.identifier}}`, etc.; whitespace inside the braces is allowed) */
export const STAGE_INSTRUCTION_VARIABLES = [
  'issue.identifier',
  'issue.title',
  'from',
  'to',
  'owner.name',
] as const;
export type StageInstructionVariable =
  (typeof STAGE_INSTRUCTION_VARIABLES)[number];

/** Definition validation limits (§5) */
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

/** The 9 built-in statuses (7 core + iteration 4's 2 design-first statuses): cannot be deleted, key and category cannot be changed */
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

/** One definition-validation error; `path` looks like `statuses[3].onEnter[0].agentId` */
export interface WorkflowValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** `details` of a 400 `INVALID_WORKFLOW` */
export interface WorkflowValidationDetails {
  readonly issues: readonly WorkflowValidationIssue[];
}

// ---------- Run triggers (§1, §2) ----------

/** A run created by runExecutor when entering a stage */
export type RunTriggerTypePhase2Workflow = 'stageEntered';
export type RunTriggerTypeV5 = RunTriggerTypeV4 | RunTriggerTypePhase2Workflow;

/** Payload of a `stageEntered` trigger record */
export interface StageEnteredPayload {
  readonly from: string;
  readonly to: string;
  /** The rendered stage instruction; null when there is no instruction template */
  readonly instruction: string | null;
}

/** Addition to the claim payload's `triggers[]`: a `stageEntered` trigger carries the stage and instruction (the daemon reads this as optional) */
export interface ClaimedTriggerPhase2Extras {
  readonly stage?: StageEnteredPayload;
}

/** Addition to the claim payload's `issue`: the checklist for the current status (null when there is no checklist) */
export interface ClaimedRunWorkflowExtras {
  readonly issue: {
    readonly checklist: IssueChecklist | null;
  };
}

// ---------- Executor proposals (§3) ----------

export type ProposalSource = 'agent' | 'workflow';
/** Added proposal status: a workflow proposal becomes stale once the issue leaves that status */
export type ProposalStatusPhase2Workflow = 'superseded';
export type ProposalStatusV5 = ProposalStatus | ProposalStatusPhase2Workflow;

/** Fields added to a proposal; `proposedByAgentId` is null when `source = workflow` */
export interface ExecutorProposalV5 extends Omit<
  ExecutorProposal,
  'status' | 'proposedByAgentId' | 'proposedByAgentName'
> {
  readonly status: ProposalStatusV5;
  readonly proposedByAgentId: string | null;
  readonly proposedByAgentName: string | null;
  readonly source: ProposalSource;
  /** For a workflow proposal: the status that generated it */
  readonly stageStatusKey: string | null;
}

/** The data of `POST /np/issues/:id/proposals/accept-all` (proposals include the V5 fields) */
export type AcceptAllProposalsResponseV5 = Omit<
  AcceptAllProposalsResponse,
  'accepted'
> & { readonly accepted: readonly ExecutorProposalV5[] };

/** The data of `POST /np/agent/issues` (the proposal includes the V5 fields) */
export type AgentCreateIssueResponseV5 = Omit<
  AgentCreateIssueResponse,
  'proposal'
> & { readonly proposal: ExecutorProposalV5 | null };

// ---------- Checklist (§6) ----------

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

/** A status's checklist snapshot (generated from the definition when the status is entered) */
export interface IssueChecklist {
  readonly statusKey: string;
  /** Whether this is the issue's current status */
  readonly current: boolean;
  /** Whether all required items are checked */
  readonly complete: boolean;
  readonly items: readonly IssueChecklistItem[];
}

/**
 * The data of `GET /np/issues/:id/checklists`, `GET /np/agent/issues/:id/checklists` (current status
 * first, the rest ordered by generation time).
 * The request body of `PATCH /np/issues/:id/checklists/:statusKey/items/:itemKey`,
 * `PATCH /np/agent/issues/:id/checklists/...`; the response data is that status's IssueChecklist.
 */
export interface UpdateChecklistItemRequest {
  readonly checked: boolean;
}

// ---------- Settings ----------

/** Loop prevention: at most `stageRunLimit` runExecutor calls per issue per status within `stageRunWindowHours` hours */
export interface WorkspaceSettingsPhase2WorkflowFields {
  readonly stageRunLimit: number;
  readonly stageRunWindowHours: number;
}
/** `GET/PATCH /np/settings`: adds the two loop-prevention fields (owner/admin can change them: count 1-100, window 1-720 hours) */
export type WorkspaceSettingsViewV5 = WorkspaceSettingsViewV4 &
  WorkspaceSettingsPhase2WorkflowFields;
export type UpdateWorkspaceSettingsRequestV5 =
  UpdateWorkspaceSettingsRequestV4 &
    Partial<WorkspaceSettingsPhase2WorkflowFields>;
export const DEFAULT_STAGE_RUN_LIMIT = 3;
export const DEFAULT_STAGE_RUN_WINDOW_HOURS = 24;

// ---------- Activity, inbox, error codes ----------

export type ActivityActionPhase2Workflow =
  | 'stage_action_applied'
  | 'stage_action_skipped'
  | 'stage_action_failed'
  | 'stage_action_suppressed'
  | 'checklist_item_checked'
  | 'checklist_item_unchecked'
  | 'approval_stale';

/** `details.reason` of `stage_action_skipped` */
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
 * `stage_entered`: notifyOwner (info, to the owner); `stage_action_problem`: a stage action was
 * skipped, failed, or suppressed (info, to the owner); `approval_stale`: the entry condition was no
 * longer met by the time approval was granted, so the request became stale (info, to the approver and
 * the requester)
 */
export type InboxItemTypePhase2Workflow =
  'stage_entered' | 'stage_action_problem' | 'approval_stale';
export type InboxItemTypeV5 = InboxItemTypeV4 | InboxItemTypePhase2Workflow;

export const ERROR_STAGE_PR_NOT_MERGED = 'STAGE_PR_NOT_MERGED';
export const ERROR_CHECKLIST_INCOMPLETE = 'CHECKLIST_INCOMPLETE';
export const ERROR_INVALID_WORKFLOW = 'INVALID_WORKFLOW';
