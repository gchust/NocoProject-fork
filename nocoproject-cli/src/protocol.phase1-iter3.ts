/**
 * NocoProject protocol types: Phase 1 iteration 3 additions (docs/phase1/iteration-3-contract.md §J;
 * implementation in docs/phase1/protocol-iteration-3.md).
 *
 * Server source of truth; the CLI copies this file with `pnpm sync-protocol`. This file only imports
 * types from protocol.ts and protocol.phase1-iter2.ts; composite types that depend on server-only
 * additional shapes (IssueDetailV2, etc.) live in protocol.phase1-iter3-server.ts (not copied by the
 * CLI).
 * Additive only: the original union types stay unchanged, and added enum values are written as
 * separate types (InboxItemTypePhase1Iter3, etc.) and then merged in.
 */
import type {
  Activity,
  IssueListItemV1,
  ProjectDetail,
  Workflow,
} from './protocol.js';
import type {
  ApprovalRequest,
  CommentV2,
  InboxItemTypeV2,
  InboxItemV2,
  IssuePhase2Fields,
  IssueStatusSnapshot,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsView,
} from './protocol.phase1-iter2.js';

// ---------- Knowledge base (§B) ----------

/** Who last updated the document (`knowledgeDocs.updatedByType`) */
export type KnowledgeAuthorType = 'user' | 'agent';
/** Version author (`knowledgeDocVersions.authorType`; system is not written yet, kept for later) */
export type KnowledgeVersionAuthorType = 'user' | 'agent' | 'system';
export type KnowledgeProposalStatus = 'pending' | 'accepted' | 'rejected';

export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_SUMMARY_MAX = 300;
export const KNOWLEDGE_REASON_MAX = 500;
export const KNOWLEDGE_NOTE_MAX = 500;
export const KNOWLEDGE_CONTENT_MAX = 200_000;
/** slug: lowercase letters, digits, and hyphens, 1-64 chars, not starting with a hyphen */
export const KNOWLEDGE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** Maximum nesting depth of the document tree; a root document is depth 1 (NP-147). */
export const KNOWLEDGE_MAX_DEPTH = 4;

/** Element of `GET /np/knowledge`, `GET /np/agent/knowledge` (without the body) */
export interface KnowledgeDocSummary {
  readonly id: string;
  /** null = a system-wide document */
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  /** null = a root document; otherwise the id of its parent document in the same scope (NP-147) */
  readonly parentId: string | null;
  /** Position among its siblings (NP-147) */
  readonly sortOrder: number;
  /** Number of direct, non-archived child documents (NP-147) */
  readonly childCount: number;
  /** Starts at 1, +1 on every update */
  readonly version: number;
  readonly updatedByType: KnowledgeAuthorType;
  readonly updatedById: string | null;
  readonly updatedByName: string | null;
  readonly archivedAt: string | null;
  /** Number of pending proposals on this document */
  readonly pendingProposalCount: number;
  /** Whether the current user can modify it (project lead, owner/admin; system-wide docs are owner/admin only); always false in the agent interface */
  readonly canEdit: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * A short window of the body around the first hit, when `q` matched the content and not the title, slug or
   * summary (those are already visible on the row); absent otherwise (NP-142).
   */
  readonly matchExcerpt?: string;
}

/** Includes the Markdown body */
export interface KnowledgeDoc extends KnowledgeDocSummary {
  readonly content: string;
}

export interface KnowledgeVersionSummary {
  readonly docId: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly authorType: KnowledgeVersionAuthorType;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly sourceRunId: string | null;
  readonly proposalId: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface KnowledgeDocVersion extends KnowledgeVersionSummary {
  readonly content: string;
}

export interface KnowledgeProposal {
  readonly id: string;
  /** null = a proposal to create a new document (backfilled with the new document's id once accepted) */
  readonly docId: string | null;
  /** The existing document's title (the proposed title when creating a new one) */
  readonly docTitle: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  /** The proposed title (an empty string when updating an existing document means don't change the title) */
  readonly title: string;
  /** The slug when creating a new document (may get a suffix on accept if the name collides) */
  readonly slug: string | null;
  readonly summary: string;
  readonly content: string;
  readonly reason: string;
  readonly isNew: boolean;
  /** The document's version when the proposal was made (null when creating a new one) */
  readonly baseVersion: number | null;
  /** 文档现在的版本（新建为 null）；大于 `baseVersion` 说明接受前有人先改了文档 */
  readonly currentVersion: number | null;
  readonly proposedByAgentId: string;
  readonly proposedByAgentName: string | null;
  readonly sourceRunId: string | null;
  readonly sourceIssueId: string | null;
  readonly sourceIssueIdentifier: string | null;
  readonly status: KnowledgeProposalStatus;
  readonly decidedById: string | null;
  readonly decidedByName: string | null;
  readonly decidedAt: string | null;
  readonly comment: string | null;
  /** Whether the current user can decide it (browser interface; always false in the agent interface) */
  readonly canDecide: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `GET /np/knowledge/:id` */
export interface KnowledgeDocDetail {
  readonly doc: KnowledgeDoc;
  /** Newest version first */
  readonly versions: readonly KnowledgeVersionSummary[];
  /** Pending proposals on this document (newest first) */
  readonly proposals: readonly KnowledgeProposal[];
  /** Ancestors from the root to this document's parent (NP-147) */
  readonly breadcrumbs: readonly { id: string; title: string; slug: string }[];
}

export interface CreateKnowledgeDocRequest {
  readonly projectId?: string | null;
  readonly title: string;
  readonly slug?: string;
  readonly summary?: string;
  readonly content: string;
  /** The parent document's id, in the same scope; omitted/null = a root document (NP-147) */
  readonly parentId?: string | null;
}

export interface UpdateKnowledgeDocRequest {
  readonly title?: string;
  readonly summary?: string;
  readonly content?: string;
  readonly note?: string;
  readonly expectedVersion: number;
}

/**
 * `PATCH /np/knowledge/:id` (NP-147): moves a document to a new parent/position. Distinguished from
 * UpdateKnowledgeDocRequest by carrying `parentId` and/or `sortOrder`. Does not create a new content version.
 */
export interface MoveKnowledgeDocRequest {
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly expectedVersion?: number;
}

export interface DecideKnowledgeProposalRequest {
  readonly comment?: string;
  /** 接受一条已过期的建议（`baseVersion < currentVersion`）时带上，绕过 409 `KNOWLEDGE_PROPOSAL_STALE` */
  readonly confirmStale?: boolean;
}

/** `POST /np/agent/knowledge/proposals`: exactly one of `docId` (id or slug) or `title` (+ optional `slug`) */
export interface AgentKnowledgeProposalRequest {
  readonly docId?: string;
  readonly title?: string;
  readonly slug?: string;
  /** The project when creating a new document; defaults to the run's project, null = system-wide */
  readonly projectId?: string | null;
  readonly summary?: string;
  readonly content: string;
  readonly reason: string;
  /** The parent document's id or slug, in the same scope; only used when creating a new document (NP-147) */
  readonly parentId?: string;
}

/** Element of the claim payload's `knowledge[]` (an index, without the body). Root documents only (NP-147). */
export interface ClaimedKnowledgeDoc {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly projectId: string | null;
  /** Number of direct, non-archived child documents (NP-147) */
  readonly childCount: number;
}

/** Fields added to ClaimedRun in iteration 3 (the daemon reads them as optional) */
export interface ClaimedRunPhase3Extras {
  /** Root documents of the run's own project come first, then system-wide ones; excludes archived documents */
  readonly knowledge: readonly ClaimedKnowledgeDoc[];
}

// ---------- Acceptance metrics (§C) ----------

export type MetricStatus = 'ok' | 'warn' | 'n/a';

/** `settings.metricThresholds`; see METRIC_THRESHOLD_DIRECTIONS for direction */
export interface MetricThresholds {
  /** aiShare.share ≥ */
  readonly aiShare: number;
  /** trust.proposalAcceptRate ≥ */
  readonly proposalAcceptRate: number;
  /** reliability.claimLatencyP50Ms ≤ */
  readonly claimLatencyP50Ms: number;
  /** reliability.lostRuns ≤ */
  readonly lostRuns: number;
  /** humanLoad.decisionResolveP50Ms ≤ */
  readonly decisionResolveP50Ms: number;
}

export type MetricThresholdKey = keyof MetricThresholds;

export const METRIC_THRESHOLD_KEYS: readonly MetricThresholdKey[] = [
  'aiShare',
  'proposalAcceptRate',
  'claimLatencyP50Ms',
  'lostRuns',
  'decisionResolveP50Ms',
];

/** min: ok when the value ≥ threshold; max: ok when the value ≤ threshold */
export const METRIC_THRESHOLD_DIRECTIONS: Readonly<
  Record<MetricThresholdKey, 'min' | 'max'>
> = {
  aiShare: 'min',
  proposalAcceptRate: 'min',
  claimLatencyP50Ms: 'max',
  lostRuns: 'max',
  decisionResolveP50Ms: 'max',
};

export const DEFAULT_METRIC_THRESHOLDS: MetricThresholds = {
  aiShare: 0.5,
  proposalAcceptRate: 0.7,
  claimLatencyP50Ms: 3000,
  lostRuns: 0,
  decisionResolveP50Ms: 24 * 3600 * 1000,
};

export interface MetricsAdoption {
  readonly activeWeeks: number;
  readonly activeDays: number;
  readonly issuesCreated: number;
  readonly activeMembers: number;
}

export interface MetricsAiShare {
  readonly deliveredByAgent: number;
  readonly deliveredTotal: number;
  /** null when there were no deliveries */
  readonly share: number | null;
}

export interface MetricsTrust {
  readonly proposalAcceptRate: number | null;
  readonly reviewPassRate: number | null;
  readonly approvalApproveRate: number | null;
  readonly reworkRate: number | null;
}

export interface MetricsReliability {
  readonly runs: number;
  readonly failedRuns: number;
  readonly failuresByReason: Readonly<Record<string, number>>;
  readonly claimLatencyP50Ms: number | null;
  readonly claimLatencyP95Ms: number | null;
  readonly runDurationP50Ms: number | null;
  readonly lostRuns: number;
}

export interface MetricsCostByAgent {
  readonly agentId: string;
  readonly name: string;
  readonly cost: number | null;
}

export interface MetricsCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number | null;
  readonly costPerDeliveredIssue: number | null;
  readonly byAgent: readonly MetricsCostByAgent[];
}

export interface MetricsHumanLoad {
  readonly decisionsCreated: number;
  readonly decisionsResolved: number;
  readonly decisionResolveP50Ms: number | null;
  readonly openDecisions: number;
  /** Decision items created in the period, counted by type */
  readonly byType: Readonly<Partial<Record<InboxItemTypeV3, number>>>;
}

/** `GET /np/metrics` */
export interface MetricsReport {
  /** UTC dates, inclusive of both ends */
  readonly from: string;
  readonly to: string;
  readonly projectId: string | null;
  readonly generatedAt: string;
  readonly adoption: MetricsAdoption;
  readonly aiShare: MetricsAiShare;
  readonly trust: MetricsTrust;
  readonly reliability: MetricsReliability;
  readonly cost: MetricsCost;
  readonly humanLoad: MetricsHumanLoad;
  readonly thresholds: MetricThresholds;
  readonly statuses: Readonly<Record<MetricThresholdKey, MetricStatus>>;
}

/** Addition to `GET /np/settings` */
export type WorkspaceSettingsViewV3 = WorkspaceSettingsView & {
  readonly metricThresholds: MetricThresholds;
};

/** Addition to `PATCH /np/settings` (partial keys are fine; merged with the stored value) */
export type UpdateWorkspaceSettingsRequestV3 =
  UpdateWorkspaceSettingsRequest & {
    readonly metricThresholds?: Partial<MetricThresholds>;
  };

// ---------- Pagination (§D) ----------

export const ISSUE_PAGE_DEFAULT_LIMIT = 50;
export const ISSUE_PAGE_MAX_LIMIT = 100;
export const BOARD_COLUMN_DEFAULT_LIMIT = 50;
export const ACTIVITY_PAGE_DEFAULT_LIMIT = 50;
export const ACTIVITY_PAGE_MAX_LIMIT = 200;
/** Comments in a detail view are only paginated past this count */
export const DETAIL_COMMENTS_LIMIT = 200;

/** An issue list row (the server's IssueListItemV2) */
export type IssueListRow = IssueListItemV1 & IssuePhase2Fields;

/** Full response body of `GET /np/issues` (`nextCursor` is a sibling of `data`; null = last page) */
export interface IssueListPage<T = IssueListRow> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export interface BoardGroupV3<T = IssueListRow> {
  readonly statusKey: string;
  readonly issues: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/** The data of `GET /np/issues?view=board` (only that one column when `statusKey` is given) */
export interface IssueBoardResponseV3<T = IssueListRow> {
  readonly groups: readonly BoardGroupV3<T>[];
}

/** Full response body of `GET /np/issues/:id/activities`; `data` is ascending by time, `nextCursor` gets an earlier page */
export interface ActivityPage {
  readonly data: readonly Activity[];
  readonly nextCursor: string | null;
}

/** Full response body of `GET /np/issues/:id/comments`; `data` is ascending by time, `nextCursor` gets an earlier page */
export interface CommentPage {
  readonly data: readonly CommentV2[];
  readonly nextCursor: string | null;
}

/** Pagination cursors added to the issue detail */
export interface IssueDetailPaging {
  readonly activitiesNextCursor: string | null;
  readonly commentsNextCursor: string | null;
}

// ---------- Direct inbox actions and delivery (§E) ----------

export type InboxActionKind = 'primary' | 'secondary' | 'danger';
/** GET = navigate (an in-app route, or an external URL when `external`); POST = call the endpoint (path relative to `/api`) */
export type InboxActionMethod = 'GET' | 'POST';

export interface InboxAction {
  readonly key: string;
  /** i18n key: `np.inboxActions.<key>` */
  readonly label: string;
  readonly kind: InboxActionKind;
  readonly method: InboxActionMethod;
  /** POST: the endpoint path (e.g. `/np/issues/<id>/deliveries/accept`); GET: an in-app route (e.g. `/issues/NP-12`) or an external URL */
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  /** A comment must be filled in first; it is written into `body[commentField]` */
  readonly needsComment?: boolean;
  /** Comment field name, defaults to `comment` (`content` when replying to an agent) */
  readonly commentField?: string;
  /** Opens the issue detail (to continue the action there) */
  readonly opensIssue?: boolean;
  /** `path` is an external URL (opened in a new window) */
  readonly external?: boolean;
}

export interface AcceptDeliveryRequest {
  readonly comment?: string;
}

export interface RequestChangesRequest {
  readonly comment: string;
}

/**
 * The data of `POST /np/issues/:id/deliveries/accept | request-changes` (200; 202 with `issue`
 * unchanged when the status change needs approval).
 * `issue` is the full issue row (the server's IssueV2); only the fields the CLI reads are listed here.
 */
export interface DeliveryResult {
  readonly issue: IssueStatusSnapshot;
  readonly pendingApproval: ApprovalRequest | null;
  readonly comment: CommentV2 | null;
}

// ---------- Workflow templates (§F) ----------

/** Row of `GET /np/workflows` and `GET /np/workflows/:id` (`isDefault` is already on Workflow) */
export type WorkflowListItem = Workflow & {
  /** Number of projects using this template (the default template includes projects with no template specified) */
  readonly projectCount: number;
};

// ---------- Project detail (§B) ----------

/** `GET /np/projects/:id` adds project documents (excludes system-wide and archived ones) */
export type ProjectDetailV3 = ProjectDetail & {
  readonly knowledgeDocs: readonly KnowledgeDocSummary[];
};

// ---------- Added enum values ----------

export type InboxItemTypePhase1Iter3 =
  'knowledge_proposal' | 'knowledge_decided';
/** All inbox types across iterations 1-3 */
export type InboxItemTypeV3 = InboxItemTypeV2 | InboxItemTypePhase1Iter3;
/** An inbox item (`type` includes iteration 3's types; see InboxAction for `payload.actions`) */
export type InboxItemV3 = Omit<InboxItemV2, 'type'> & {
  readonly type: InboxItemTypeV3;
};
export type ActivityActionPhase1Iter3 =
  | 'knowledge_proposed'
  | 'knowledge_updated'
  | 'delivery_accepted'
  | 'changes_requested';
