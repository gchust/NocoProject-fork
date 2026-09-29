/**
 * Browser-side types for Phase 1 iteration 3 (`docs/phase1/iteration-3-contract.md` §B–§F, §J).
 *
 * Copied from the contract rather than imported from `server/modules/shared/protocol.phase1-iter3.ts`, for the same
 * reason as `types.ts`: the client tsconfig must not reach into `server/`. The server's protocol document is written in
 * parallel, so fields the contract states only in prose are optional and `api-iter3.ts` normalizes the envelopes.
 */
import type { IssueActivity, IssueListItem } from './types.js';
import type {
  InboxItemType,
  Workflow,
  WorkflowDefinition,
  WorkflowTransitionDefinition,
} from './types-collab.js';
import type { ApproverRole } from './types-iter2.js';

// ---------- §B knowledge ----------

export type KnowledgeAuthorType = 'user' | 'agent' | 'system';
export type KnowledgeProposalStatus = 'pending' | 'accepted' | 'rejected';

/** One row of `GET /np/knowledge` (no content). `projectId: null` is a workspace-level document. */
export interface KnowledgeDocSummary {
  readonly id: string;
  readonly projectId: string | null;
  readonly projectName?: string | null;
  readonly title: string;
  readonly slug: string;
  readonly summary: string | null;
  readonly version: number;
  readonly updatedByType?: 'user' | 'agent';
  readonly updatedById?: string | null;
  readonly updatedByName?: string | null;
  readonly archivedAt?: string | null;
  readonly pendingProposalCount?: number;
  readonly createdAt?: string;
  readonly updatedAt: string;
  /** Whether the viewer may edit it (project lead, owner/admin); read when the server sends it. */
  readonly canEdit?: boolean;
}

export interface KnowledgeDoc extends KnowledgeDocSummary {
  readonly content: string;
}

export interface KnowledgeVersionSummary {
  readonly version: number;
  readonly title: string;
  readonly summary?: string | null;
  readonly authorType: KnowledgeAuthorType;
  readonly authorId?: string | null;
  readonly authorName?: string | null;
  readonly sourceRunId?: string | null;
  readonly proposalId?: string | null;
  readonly note?: string | null;
  readonly createdAt: string;
}

export interface KnowledgeDocVersion extends KnowledgeVersionSummary {
  readonly docId: string;
  readonly content: string;
}

export interface KnowledgeProposal {
  readonly id: string;
  /** Null for a proposal that creates a new document. */
  readonly docId: string | null;
  readonly docTitle?: string | null;
  readonly projectId: string | null;
  readonly projectName?: string | null;
  readonly title: string;
  readonly slug?: string | null;
  readonly summary?: string | null;
  readonly content: string;
  readonly reason: string | null;
  /** The document's version this proposal was based on (null for a new document). */
  readonly baseVersion?: number | null;
  /** The document's version now (null for a new document); greater than `baseVersion` means it moved on meanwhile. */
  readonly currentVersion?: number | null;
  readonly proposedByAgentId: string;
  readonly proposedByAgentName?: string | null;
  readonly sourceRunId?: string | null;
  readonly sourceIssueId?: string | null;
  readonly sourceIssueIdentifier?: string | null;
  readonly status: KnowledgeProposalStatus;
  readonly decidedById?: string | null;
  readonly decidedAt?: string | null;
  readonly comment?: string | null;
  readonly createdAt: string;
}

/** `GET /np/knowledge/:id`. */
export interface KnowledgeDetail {
  readonly doc: KnowledgeDoc;
  readonly versions: readonly KnowledgeVersionSummary[];
  readonly proposals: readonly KnowledgeProposal[];
}

export interface CreateKnowledgeInput {
  readonly projectId?: string | null;
  readonly title: string;
  readonly slug?: string;
  readonly summary?: string;
  readonly content: string;
}

export interface UpdateKnowledgeInput {
  readonly title?: string;
  readonly summary?: string;
  readonly content?: string;
  readonly note?: string;
  readonly expectedVersion: number;
}

// ---------- §C metrics ----------

export type MetricStatus = 'ok' | 'warn' | 'n/a';

export interface MetricThresholds {
  readonly aiShare?: number;
  readonly proposalAcceptRate?: number;
  readonly claimLatencyP50Ms?: number;
  readonly lostRuns?: number;
  readonly decisionResolveP50Ms?: number;
  readonly [key: string]: number | undefined;
}

/**
 * A metric value. The contract says "each metric gives a value and its computation definition"; a bare number and
 * `{ value, definition }` are both read, see
 * `metricValue` in `api-iter3.ts`.
 */
export type MetricRaw =
  | number
  | null
  | { readonly value: number | null; readonly definition?: string };

export interface MetricsAdoption {
  readonly activeWeeks: MetricRaw;
  readonly activeDays: MetricRaw;
  readonly issuesCreated: MetricRaw;
  readonly activeMembers: MetricRaw;
}

export interface MetricsAiShare {
  readonly deliveredByAgent: MetricRaw;
  readonly deliveredTotal: MetricRaw;
  readonly share: MetricRaw;
}

export interface MetricsTrust {
  readonly proposalAcceptRate: MetricRaw;
  readonly reviewPassRate: MetricRaw;
  readonly approvalApproveRate: MetricRaw;
  readonly reworkRate: MetricRaw;
}

export interface MetricsReliability {
  readonly runs: MetricRaw;
  readonly failedRuns: MetricRaw;
  readonly failuresByReason: Readonly<Record<string, number>>;
  readonly claimLatencyP50Ms: MetricRaw;
  readonly claimLatencyP95Ms: MetricRaw;
  readonly runDurationP50Ms: MetricRaw;
  readonly lostRuns: MetricRaw;
}

export interface MetricsCost {
  readonly inputTokens: MetricRaw;
  readonly outputTokens: MetricRaw;
  readonly estimatedCost: MetricRaw;
  readonly costPerDeliveredIssue: MetricRaw;
  readonly byAgent: readonly {
    readonly agentId: string;
    readonly name: string | null;
    readonly cost: number | null;
  }[];
}

export interface MetricsHumanLoad {
  readonly decisionsCreated: MetricRaw;
  readonly decisionsResolved: MetricRaw;
  readonly decisionResolveP50Ms: MetricRaw;
  readonly openDecisions: MetricRaw;
  readonly byType: Readonly<Record<string, number>>;
}

export interface MetricsReport {
  readonly from?: string;
  readonly to?: string;
  readonly projectId?: string | null;
  readonly adoption: MetricsAdoption;
  readonly aiShare: MetricsAiShare;
  readonly trust: MetricsTrust;
  readonly reliability: MetricsReliability;
  readonly cost: MetricsCost;
  readonly humanLoad: MetricsHumanLoad;
  readonly thresholds: MetricThresholds;
  /** Per metric key (`share`, `proposalAcceptRate`, …), when the server computes them. */
  readonly statuses: Readonly<Record<string, MetricStatus>>;
}

export interface MetricsQuery {
  readonly from: string;
  readonly to: string;
  readonly projectId?: string;
}

// ---------- §D pagination ----------

export interface IssueListPage {
  readonly data: readonly IssueListItem[];
  /** Null on the last page; a server without cursors answers a bare list, read as one last page. */
  readonly nextCursor: string | null;
}

export interface BoardGroupV3 {
  readonly statusKey: string;
  readonly issues: readonly IssueListItem[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface ActivityPage {
  readonly data: readonly IssueActivity[];
  readonly nextCursor: string | null;
}

// ---------- §E inbox decisions ----------

export type InboxDecisionKind = 'primary' | 'secondary' | 'danger';

/** `payload.actions[]` of a decision item. Named apart from `api-inbox.ts`'s read/archive `InboxAction`. */
export interface InboxDecisionAction {
  readonly key: string;
  /** An i18n key (`np.inboxActions.accept`, …); an unknown key falls back to `key`. */
  readonly label: string;
  readonly kind: InboxDecisionKind;
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** An API path (`/np/issues/1/deliveries/accept`), or an external URL for `openPr`. */
  readonly path?: string;
  readonly url?: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly needsComment?: boolean;
  /** Where the comment goes in the body (`content` for a reply); `comment` by default. */
  readonly commentField?: string;
  readonly opensIssue?: boolean;
  /** A GET action whose `path` is another site (the PR), opened in a new tab. */
  readonly external?: boolean;
  /** NP-85: open this confirm dialog instead of posting (`prMerge`: the merge dialog for `pullRequestId`). */
  readonly confirm?: 'prMerge';
  readonly pullRequestId?: string;
  /** NP-85: shown greyed out with this reason (a merge blocker). */
  readonly disabledReason?: string;
}

export type InboxItemTypePhase1Iter3 =
  'knowledge_proposal' | 'knowledge_decided';
export type InboxItemTypeV3 = InboxItemType | InboxItemTypePhase1Iter3;

// ---------- §F workflows ----------

export interface TransitionApprovalV3 {
  readonly approvers: readonly ApproverRole[];
}

export type WorkflowTransitionV3 = WorkflowTransitionDefinition & {
  readonly approval?: TransitionApprovalV3;
};

export interface WorkflowDefinitionV3 extends Omit<
  WorkflowDefinition,
  'transitions'
> {
  readonly transitions: readonly WorkflowTransitionV3[];
}

/** One row of `GET /np/workflows` with the iteration 3 additions. */
export interface WorkflowListItem extends Omit<Workflow, 'definition'> {
  readonly definition: WorkflowDefinitionV3;
  readonly projectCount?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}
