/**
 * Browser-side types for Phase 1 iteration 4 (`docs/phase1/iteration-4-contract.md`): the design-first process (§B),
 * the project manager agent (§C) and the unified "new issue" dialog (§D). Copied from the contract rather than
 * imported from `server/modules/shared/protocol.phase1-iter4.ts` (see `types.ts`); the optional fields they add to
 * existing shapes are declared on those shapes in `types.ts` / `types-iter2.ts`.
 */

/** `issues.process` (§A). */
export type IssueProcess = 'direct' | 'design_first';

/** What the create forms offer: `auto` lets the server decide (`settings.defaultProcess`, then its classifier). */
export type ProcessChoice = 'auto' | IssueProcess;

export const PROCESS_CHOICES: readonly ProcessChoice[] = [
  'auto',
  'direct',
  'design_first',
];

/** The two built-in statuses of the design-first process, after `todo` (§A). */
export const STATUS_ANALYSIS = 'analysis';
export const STATUS_PROPOSAL_REVIEW = 'proposal_review';
export const DESIGN_STATUS_KEYS: ReadonlySet<string> = new Set([
  STATUS_ANALYSIS,
  STATUS_PROPOSAL_REVIEW,
]);

/** `comments.kind` gains `proposal` (§A): the agent's design proposal, a top-level Markdown comment. */
export type CommentKindPhase1Iter4 = 'proposal';

/** `agents.kind` (§C): legacy display metadata; capability configuration determines execution eligibility. */
export type AgentKind = 'coder' | 'manager';
export const AGENT_KINDS: readonly AgentKind[] = ['coder', 'manager'];

/** `agents.reasoningEffort` (§C); null is the tool's default. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'max',
];

/** Run triggers added in iteration 4: the implementation run after approval, and the retrospective run (§B, §C). */
export type RunTriggerTypePhase1Iter4 = 'designApproved' | 'retrospective';

/** The inbox decision raised when an issue enters `proposal_review` (§B). */
export const DESIGN_REVIEW_TYPE = 'design_review';

/** `settings.defaultProcess` (§A). */
export type DefaultProcess = ProcessChoice;

/** The workspace settings iteration 4 adds (§A); read and written through `GET` / `PATCH /np/settings`. */
export interface WorkspaceSettingsPhase1Iter4 {
  readonly defaultProcess?: DefaultProcess;
  readonly pmAgentId?: string | null;
  readonly retrospectiveOnDone?: boolean;
}

/** `GET` / `POST /np/pm/conversation` (§C), normalized; `issueId` is null when the server has none to give. */
export interface PmConversation {
  readonly issueId: string | null;
}

/** The latest design proposal as the claim payload and possibly the issue detail carry it (`issue.designProposal`). */
export interface DesignProposal {
  readonly commentId: string;
  readonly content: string;
  readonly createdAt: string;
}

/** Error codes of iteration 4 the pages translate. */
export const ERROR_PROCESS_LOCKED = 'PROCESS_LOCKED';
export const ERROR_MANAGER_NOT_EXECUTOR = 'MANAGER_NOT_EXECUTOR';
export const ERROR_DESIGN_NOT_APPROVED = 'DESIGN_NOT_APPROVED';
export const ERROR_PM_NOT_CONFIGURED = 'PM_NOT_CONFIGURED';

// ---------- NP-85: merging a pull request ----------

/** Why a PR cannot be merged (server `PullRequestMergeBlocker`). */
export type MergeBlocker =
  | 'closed'
  | 'merged'
  | 'draft'
  | 'conflicts'
  | 'computing'
  | 'ciPending'
  | 'ciFailed'
  | 'ciMissing'
  | 'notConfigured'
  | 'protected';

export const MERGE_BLOCKERS: readonly MergeBlocker[] = [
  'closed',
  'merged',
  'draft',
  'conflicts',
  'computing',
  'ciPending',
  'ciFailed',
  'ciMissing',
  'notConfigured',
  'protected',
];

/** Why merging leaves the issue as it is. */
export type MergeKeepReason = 'setting' | 'otherPrs' | 'optedOut' | 'terminal';

/** `GET /np/issues/:id/pull-requests/:prId/merge`, read fresh from GitHub. */
export interface MergePreflight {
  readonly blocker: MergeBlocker | null;
  readonly method: 'squash';
  readonly headSha: string;
  readonly baseRef: string;
  readonly commitTitle: string;
  readonly statusAfter: {
    readonly statusKey: string | null;
    readonly statusName: string | null;
    readonly keepReason: MergeKeepReason | null;
  };
}
