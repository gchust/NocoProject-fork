import type {
  AgentConfiguration,
  AgentEntryBindings,
} from './protocol.capabilities.js';
/**
 * NocoProject protocol types: Phase 1 iteration 4 additions (docs/phase1/iteration-4-contract.md;
 * implementation in docs/phase1/protocol-iteration-4.md).
 *
 * Server source of truth; the CLI copies this file with `pnpm sync-protocol`. This file only imports
 * types from protocol.ts, protocol.phase1-iter2.ts, and protocol.phase1-iter3.ts; composite types that
 * depend on server-only additional shapes (IssueV2, IssueDetailV3, etc.) live in
 * protocol.phase1-iter4-server.ts (not copied by the CLI).
 * Additive only: the original union types stay unchanged, and added enum values are written as
 * separate types (InboxItemTypePhase1Iter4, etc.) and then merged in. The one exception is
 * protocol.phase1-iter2.ts's `IssueOriginType`, which gained `'pm'` directly (contract §C: "originType
 * gains pm").
 */
import type {
  Activity,
  CommentKind,
  Phase1RunTriggerType,
  ProjectListItem,
  RunSummary,
  SubtaskSummary,
  TriggeredRun,
} from './protocol.js';
import type {
  CommentV2,
  CreateIntakeBatchRequest,
  IntakeDraft,
  IntakeDraftFields,
  IntakeDraftInput,
  IssuePullRequestView,
  IssueStatusSnapshot,
  UsageRow,
} from './protocol.phase1-iter2.js';
import type {
  InboxAction,
  InboxItemTypeV3,
  InboxItemV3,
  IssueListRow,
  UpdateWorkspaceSettingsRequestV3,
  WorkspaceSettingsViewV3,
} from './protocol.phase1-iter3.js';

// ---------- Design-first (§B) ----------

/** `issues.process` */
export type IssueProcess = 'direct' | 'design_first';
export const ISSUE_PROCESSES: readonly IssueProcess[] = [
  'direct',
  'design_first',
];
/** `process` for issue creation / bulk intake, also `settings.defaultProcess`: `auto` = server classifies it */
export type DefaultProcess = 'auto' | IssueProcess;
export const DEFAULT_PROCESSES: readonly DefaultProcess[] = [
  'auto',
  'direct',
  'design_first',
];
/** `details.by` of a `process_selected` activity */
export type ProcessSelectedBy = 'user' | 'heuristic' | 'ai';

/** The two built-in design-first statuses (category started, ordered right after todo) */
export const STATUS_ANALYSIS = 'analysis';
export const STATUS_PROPOSAL_REVIEW = 'proposal_review';
/** `PATCH /np/issues/:id { process }` is only allowed in these statuses (otherwise 409 PROCESS_LOCKED) */
export const PROCESS_EDITABLE_STATUSES: readonly string[] = ['backlog', 'todo'];

/** Columns added to issues in iteration 4 */
export interface IssuePhase4Fields {
  readonly process: IssueProcess;
  readonly designApprovedAt: string | null;
  readonly designApprovedById: string | null;
}

/** Addition to `POST /np/issues`, `PATCH /np/issues/:id` (PATCH does not accept `auto`) */
export interface IssuePhase4Input {
  readonly process?: DefaultProcess;
}

/** Value added to `comments.kind`: a design proposal */
export type CommentKindPhase1Iter4 = 'proposal';
export type CommentKindV4 = CommentKind | CommentKindPhase1Iter4;

/** `POST /np/agent/issues/:id/design-proposal`; responds 201 `{ data: CommentV2 }` (a top-level comment with kind = 'proposal') */
export interface AgentDesignProposalRequest {
  readonly content: string;
}
export const DESIGN_PROPOSAL_MAX = 200_000;

/** The latest design proposal (the latest comment with kind = 'proposal'): claim payload's `issue.designProposal`, issue detail's `issue.designProposal` */
export interface DesignProposal {
  readonly commentId: string;
  /** Markdown: understanding of the requirement / proposal / impact scope / risks and open questions / verification plan */
  readonly content: string;
  readonly createdAt: string;
}

/** `POST /np/issues/:id/design/approve` (body may be omitted) */
export interface DesignApproveRequest {
  readonly comment?: string;
}

/** `POST /np/issues/:id/design/request-changes` */
export interface DesignRequestChangesRequest {
  readonly comment: string;
}

/** The data of the two design-decision endpoints; `issue` is the full issue row (the server's IssueV4); only the fields the CLI reads are listed here */
export interface DesignDecisionResult<TIssue = IssueStatusSnapshot> {
  readonly issue: TIssue & IssuePhase4Fields;
  readonly comment: CommentV2 | null;
  readonly triggered: readonly TriggeredRun[];
}

/** The payload of a `design_review` decision item (also has identifier, issueTitle, actions) */
export interface DesignReviewPayload {
  readonly proposalCommentId: string | null;
  /** First 300 characters of the proposal body */
  readonly summary: string;
  readonly from: string | null;
}
export const DESIGN_REVIEW_SUMMARY_LENGTH = 300;

// ---------- Agent kind and reasoning effort (§C) ----------

export type AgentKind = 'coder' | 'manager';
export const AGENT_KINDS: readonly AgentKind[] = ['coder', 'manager'];
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'max',
];

/** Columns added to agents in iteration 4 (the row of `GET /np/agents`) */
export interface AgentPhase4Fields extends AgentConfiguration {
  readonly kind: AgentKind;
  readonly reasoningEffort: ReasoningEffort | null;
}

/** Addition to `POST /np/agents`, `PATCH /np/agents/:id` */
export interface AgentPhase4Input extends AgentConfiguration {
  readonly kind?: AgentKind;
  readonly reasoningEffort?: ReasoningEffort | null;
}

// ---------- Run triggers and claim payload (§B, §C) ----------

/** Trigger types added in iteration 4: the implementation run after a proposal is approved, the retrospective run after an issue is done */
export type RunTriggerTypePhase1Iter4 = 'designApproved' | 'retrospective';
export type RunTriggerTypeV4 = Phase1RunTriggerType | RunTriggerTypePhase1Iter4;
/** threadScope of a retrospective run */
export const RETROSPECTIVE_THREAD_SCOPE = 'retro';

/** Fields added to ClaimedRun in iteration 4 (the daemon reads them as optional) */
export interface ClaimedRunPhase4Extras {
  readonly agent: AgentConfiguration & {
    readonly taskInstructions?: string;
    readonly commandDescriptions?: readonly string[];
    readonly kind: AgentKind;
    readonly reasoningEffort: ReasoningEffort | null;
  };
  readonly issue: {
    readonly process: IssueProcess;
    readonly designApprovedAt: string | null;
    /** The latest proposal; null when there is none */
    readonly designProposal: DesignProposal | null;
    /** `'pm'` = a project manager conversation issue */
    readonly originType: string;
  };
}

/** Addition to the agent issue view (`GET /np/agent/issues/:id`, `/context`) */
export interface IssueForAgentPhase4Fields {
  readonly process: IssueProcess;
  readonly designApprovedAt: string | null;
}

// ---------- Project manager (§C) ----------

/** The data of `GET/POST /np/pm/conversation` */
export interface PmConversationResponse {
  readonly issueId: string;
  readonly identifier: string;
  /** The current executor (= settings.pmAgentId) */
  readonly agentId: string | null;
}

/** Query parameters of `GET /np/agent/pm/issues` */
export interface PmIssueListQuery {
  readonly projectId?: string;
  readonly statusKey?: string;
  /** A user id; `me` = the run's actorUserId (the asking member) */
  readonly ownerUserId?: string;
  readonly executorId?: string;
  readonly q?: string;
  /** ISO timestamp, or a relative duration like `7d` / `24h` / `30m` */
  readonly updatedSince?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export type PmIssueRow = IssueListRow & IssuePhase4Fields;

/** Full response body of `GET /np/agent/pm/issues` (`nextCursor` is a sibling of `data`) */
export interface PmIssueListPage<T = PmIssueRow> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

/** The data of `GET /np/agent/pm/issues/:idOrIdentifier` */
export interface PmIssueDetail<T = PmIssueRow> {
  readonly issue: T & { readonly designProposal: DesignProposal | null };
  /** The most recent 50 (ascending) */
  readonly comments: readonly CommentV2[];
  /** The most recent 50 (ascending) */
  readonly activities: readonly Activity[];
  readonly runs: readonly RunSummary[];
  readonly pullRequests: readonly IssuePullRequestView[];
  readonly subtasks: readonly SubtaskSummary[];
  /** Total usage across all of this issue's runs */
  readonly usage: UsageRow;
}

/** The data of `GET /np/agent/pm/projects` */
export type PmProjectList = readonly ProjectListItem[];

/** Number of comments / activities in the PM detail view */
export const PM_DETAIL_TAIL = 50;

// ---------- Settings (§A) ----------

export interface WorkspaceSettingsPhase4Fields {
  readonly defaultProcess: DefaultProcess;
  readonly agentEntries?: AgentEntryBindings;
  readonly pmAgentId: string | null;
  readonly retrospectiveOnDone: boolean;
}

export type WorkspaceSettingsViewV4 = WorkspaceSettingsViewV3 &
  WorkspaceSettingsPhase4Fields;

export type UpdateWorkspaceSettingsRequestV4 =
  UpdateWorkspaceSettingsRequestV3 & Partial<WorkspaceSettingsPhase4Fields>;

// ---------- Bulk intake (§D) ----------

/** Draft fields add `process` (defaults to settings.defaultProcess; auto uses the heuristic classifier on confirm) */
export type IntakeDraftFieldsV4 = IntakeDraftFields & {
  readonly process?: DefaultProcess;
  /** NP-78: batch attachments attached, on confirm, to the issue this draft creates */
  readonly attachmentIds?: readonly string[];
};

/** `POST /np/intake/batches` adds `process`: written into every draft that has no `process` */
export type CreateIntakeBatchRequestV4 = CreateIntakeBatchRequest & {
  readonly process?: DefaultProcess;
  /** NP-78: see `IntakeBatchAttachment` */
  readonly attachmentIds?: readonly string[];
};

// ---------- Merging a PR from the issue page and inbox (NP-85) ----------

/**
 * Reasons a PR cannot be merged. `closed` / `merged` / `draft`: the PR's state; `conflicts`: GitHub's
 * `mergeable === false` or `mergeable_state = dirty`; `computing`: `mergeable === null` (GitHub is still
 * computing it); `ciPending` / `ciFailed` / `ciMissing`: the head commit's checks are running / failed
 * / there are none; `notConfigured`: no GitHub token saved; `protected`: GitHub refused the merge
 * (branch protection requiring a review or an up-to-date branch, only seen at merge time).
 */
export type PullRequestMergeBlocker =
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

/** Why the issue stays unchanged after the merge: the setting says not to / other PRs are still unmerged / this PR opted out of auto-complete / the issue is already terminal */
export type PullRequestMergeKeepReason =
  'setting' | 'otherPrs' | 'optedOut' | 'terminal';

/** What happens to the issue after the merge: changes to `statusKey` when it is non-null, otherwise stays unchanged per `keepReason` */
export interface PullRequestMergeOutcome {
  readonly statusKey: string | null;
  readonly statusName: string | null;
  readonly keepReason: PullRequestMergeKeepReason | null;
}

/** The data of `GET /np/issues/:id/pull-requests/:prId/merge` (taken from GitHub's latest state) */
export interface PullRequestMergePreflight {
  readonly blocker: PullRequestMergeBlocker | null;
  readonly method: 'squash';
  readonly headSha: string;
  readonly baseRef: string;
  /** `<PR title> (#<number>)` */
  readonly commitTitle: string;
  readonly statusAfter: PullRequestMergeOutcome;
}

/** `POST /np/issues/:id/pull-requests/:prId/merge` */
export interface MergePullRequestRequest {
  /** The head shown in the confirmation dialog; 409 PR_CHANGED when it no longer matches GitHub's latest head */
  readonly expectedHeadSha: string;
}

export interface MergePullRequestResponse {
  readonly merged: true;
  readonly sha: string;
}

/** Fields added to each item of the PR list / issue detail's `pullRequests[]` */
export interface IssuePullRequestPhase4Fields {
  /** Whether the current user can merge it (the issue owner, project lead, owner/admin) */
  readonly viewerCanMerge: boolean;
  /** The head commit's latest GitHub Actions run */
  readonly ciRunUrl: string | null;
  /** That run's `screenshots` artifact (a web URL, downloaded after signing in to GitHub) */
  readonly screenshotsUrl: string | null;
}

export type IssuePullRequestViewV4 = IssuePullRequestView &
  IssuePullRequestPhase4Fields;

/** Addition to inbox actions: `confirm` = open a confirmation dialog first (`prMerge`: the merge confirmation dialog), `disabledReason` = greyed out with the reason */
export type InboxActionV4 = InboxAction & {
  readonly confirm?: 'prMerge';
  readonly disabledReason?: PullRequestMergeBlocker;
  /** The PR to merge, when `confirm: 'prMerge'` */
  readonly pullRequestId?: string;
};
// ---------- Issue attachments (NP-78) ----------

/**
 * An item of `GET /np/issues/:id/attachments`. The file itself is uploaded via
 * `POST /api/npFiles:uploadOne` (multipart, field name `file`, one at a time); after upload it is not
 * yet attached to an issue and is visible only to the uploader; `contentUrl`
 * (`/uploads/np/<uuid>.<ext>`, including the app prefix) is authorized by its issue's visibility.
 */
export interface IssueAttachment {
  readonly id: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentUrl: string;
  readonly uploadedById: string | null;
  readonly uploadedByName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Whether the caller can remove it (the uploader, issue owner, project lead, owner/admin) */
  readonly canDelete: boolean;
}

/** `POST /np/issues/:id/attachments`: can only attach files the caller uploaded themself that are not yet attached to an issue */
export interface AttachFilesRequest {
  readonly fileIds: readonly string[];
}

/** Addition to `POST /np/issues`: files attached at the same time as issue creation (same rule as above) */
export interface CreateIssueAttachmentFields {
  readonly attachmentIds?: readonly string[];
}

/**
 * The attachment metadata an agent sees when reading an issue. NP-111: includes `id`; the content is
 * downloaded with a run token: `GET /np/agent/issues/:id/attachments/:fileId/content` (the same
 * visibility scope as reading the issue; anything else returns 404).
 */
export interface AgentAttachmentInfo {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}
export interface IssueForAgentAttachmentFields {
  readonly attachments: readonly AgentAttachmentInfo[];
}
/** NP-111: the issue in the claim payload also carries attachments, so the round prompt lists the files and prompts a download */
export interface ClaimedRunAttachmentExtras {
  readonly issue: IssueForAgentAttachmentFields;
}

/**
 * AI intake (bulk intake) with attachments: `POST /np/intake/batches` adds `attachmentIds` (files the
 * caller uploaded themself, not yet attached to an issue, not yet in another batch); the files travel
 * with the batch. The first top-level draft parsed out gets all the files in
 * `fields.attachmentIds` initially, and they can be moved between drafts. On confirm, each file is
 * attached to the issue created by the draft it ended up in; files not in any draft are attached to
 * the first issue created.
 *
 * The batch detail (`GET /np/intake/batches/:id`, the create response) adds `attachments`, each item as
 * follows.
 */
export interface IntakeBatchAttachment {
  readonly id: string;
  readonly filename: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentUrl: string;
  /** The issue it is attached to (after the batch is confirmed) */
  readonly issueId: string | null;
  /** The result of AI intake reading this file (written at batch creation; null for older batches) */
  readonly readStatus: IntakeAttachmentReadStatus | null;
}

/**
 * The result of AI intake reading an attachment: `read` read successfully, `truncated` read but
 * truncated, `empty` no text found (e.g. a scanned PDF), `unsupported` an unsupported format (images,
 * etc. — only the filename is given to the model), `legacy` an old Office format (doc / xls / ppt),
 * `failed` reading failed, `skipped` not read because the total character budget was already used up.
 */
export type AttachmentReadState =
  | 'read'
  | 'truncated'
  | 'empty'
  | 'unsupported'
  | 'legacy'
  | 'failed'
  | 'skipped';
export interface IntakeAttachmentReadStatus {
  readonly state: AttachmentReadState;
  /** Character count handed to the model */
  readonly chars: number;
}
export interface IntakeBatchAttachmentsField {
  readonly attachments: readonly IntakeBatchAttachment[];
}

/**
 * NP-120: while editing drafts, have AI modify the drafts by one instruction sentence.
 * `POST /np/intake/batches/:id/refine` uses the current table (including unsaved manual edits) as the
 * source, and AI replaces the whole thing and validates it after editing, returning the same
 * `{ drafts }` shape as `PUT .../drafts`. Drafts AI kept or rewrote inherit the original draft's
 * `executor`, `ownerUserId`, `process`, `attachmentIds`. Only allowed for `draft` batches; 409
 * `AI_UNAVAILABLE` when AI is unavailable, 504 `AI_TIMEOUT` on timeout, 502 `AI_REFINE_FAILED` when the
 * reply cannot be parsed or is empty — the drafts stay unchanged on failure.
 */
export interface RefineIntakeDraftsRequest {
  /** 1-2000 characters */
  readonly instruction: string;
  readonly drafts: readonly IntakeDraftInput[];
}
export interface RefineIntakeDraftsResponse {
  readonly drafts: readonly IntakeDraft[];
}
/** Addition to the batch detail and create response: whether AI refine is currently available (an LLM is configured and set to auto) */
export interface IntakeBatchAiRefineField {
  readonly aiRefine: boolean;
}
export const MAX_REFINE_INSTRUCTION = 2000;

/** Max files attached per request */
export const MAX_ATTACHMENTS_PER_REQUEST = 10;

// ---------- Added enum values ----------

export type InboxItemTypePhase1Iter4 = 'design_review';
/** All inbox types across iterations 1-4 */
export type InboxItemTypeV4 = InboxItemTypeV3 | InboxItemTypePhase1Iter4;
export type InboxItemV4 = Omit<InboxItemV3, 'type'> & {
  readonly type: InboxItemTypeV4;
};
export type ActivityActionPhase1Iter4 =
  | 'process_selected'
  | 'design_skipped'
  | 'design_proposed'
  | 'design_approved'
  | 'design_changes_requested'
  | 'retrospective_done'
  | 'pr_merge_requested'
  | 'attachment_added'
  | 'attachment_removed';

// ---------- Error codes ----------

export const ERROR_PROCESS_LOCKED = 'PROCESS_LOCKED';
export const ERROR_DESIGN_NOT_APPROVED = 'DESIGN_NOT_APPROVED';
export const ERROR_PROPOSAL_REQUIRED = 'PROPOSAL_REQUIRED';
export const ERROR_NOT_DESIGN_FIRST = 'NOT_DESIGN_FIRST';
export const ERROR_DESIGN_ALREADY_APPROVED = 'DESIGN_ALREADY_APPROVED';
export const ERROR_MANAGER_NOT_EXECUTOR = 'MANAGER_NOT_EXECUTOR';
export const ERROR_MANAGER_ONLY = 'MANAGER_ONLY';
export const ERROR_PM_NOT_CONFIGURED = 'PM_NOT_CONFIGURED';
/** 409: the PR cannot currently be merged (`details.blocker`) */
export const ERROR_PR_NOT_MERGEABLE = 'PR_NOT_MERGEABLE';
/** 409: the PR got a new commit after confirmation */
export const ERROR_PR_CHANGED = 'PR_CHANGED';
/** 409: the token is missing write access to Contents and Pull requests */
export const ERROR_GITHUB_MERGE_FORBIDDEN = 'GITHUB_MERGE_FORBIDDEN';
export const ERROR_INVALID_ATTACHMENT = 'INVALID_ATTACHMENT';
/** NP-120: 409 AI not configured or set to rules-only; 504 AI timeout; 502 AI reply unusable */
export const ERROR_AI_UNAVAILABLE = 'AI_UNAVAILABLE';
export const ERROR_AI_TIMEOUT = 'AI_TIMEOUT';
export const ERROR_AI_REFINE_FAILED = 'AI_REFINE_FAILED';
