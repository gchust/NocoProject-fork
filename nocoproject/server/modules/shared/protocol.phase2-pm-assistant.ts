/**
 * NocoProject protocol types: the project manager assistant (NP-181 PM 2.0; contract
 * nocosolution/NocoProject/docs/phase2/protocol-pm-assistant.md, server in NP-183).
 *
 * Server source of truth; the CLI copies this file with `pnpm sync-protocol`. This file only imports
 * types from protocol.ts and the earlier protocol files.
 * Additive only: nothing here changes an existing type; new enum values are separate types.
 */
import type { AgentKnowledgeProposalRequest } from './protocol.phase1-iter3.js';
import type {
  CommentKindV4,
  ReasoningEffort,
} from './protocol.phase1-iter4.js';
import type { AgentCapability } from './protocol.capabilities.js';
import type { RunTriggerTypeV6 } from './protocol.phase2-signals.js';
import type { IssuePriority, MemberRole } from './protocol.js';

// ---------- Identity (§2) ----------

/** The fixed capabilities of every conversation run, whatever the agent itself is configured with (§2.2). */
export const PM_CAPABILITIES = [
  'context.read',
  'workspace.read',
  'comment.create',
  'knowledge.propose',
  'member.act',
  'repo.read',
] as const satisfies readonly AgentCapability[];

/** Comment kinds of the conversation: an operation plan card and its execution result (§4). */
export type CommentKindPm = 'plan' | 'plan_result';
export type CommentKindV5 = CommentKindV4 | CommentKindPm;

/** `comments.via`: a comment the project manager wrote in the asker's name (§3.5). */
export type CommentVia = 'pm';

/** A plan card finished executing: wakes the conversation's agent (§4.7). */
export type RunTriggerTypePm = 'planExecuted';
export type RunTriggerTypeV7 = RunTriggerTypeV6 | RunTriggerTypePm;

// ---------- Operations (§3, §4.2) ----------

export type PmExecutorInput =
  | { readonly type: 'none' }
  | { readonly type: 'user' | 'agent'; readonly id: string };
/** `issue`: an id or an identifier; `ref`: the `ref` of an earlier row of the same plan. */
export type PmIssueRef = { readonly issue: string } | { readonly ref: string };
export type PmIssueTarget = string | PmIssueRef;

export interface PmIssueCreateParams {
  readonly title: string;
  readonly description?: string;
  readonly projectId?: string | null;
  readonly parent?: PmIssueRef;
  readonly stage?: number;
  readonly blockedBy?: readonly PmIssueRef[];
  readonly ownerUserId?: string;
  readonly executor?: PmExecutorInput;
  readonly priority?: IssuePriority;
  readonly labelIds?: readonly string[];
  readonly process?: 'direct' | 'design_first';
  readonly startDate?: string;
  readonly dueDate?: string;
}

export interface PmIssueUpdateSet {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  readonly labelIds?: readonly string[];
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly projectId?: string | null;
  readonly process?: 'direct' | 'design_first';
  readonly ownerUserId?: string;
  readonly executor?: PmExecutorInput;
}

export type PmDecisionAction =
  'accept' | 'dismiss' | 'approve' | 'request_changes' | 'reject';

export type PmOperation =
  | {
      readonly type: 'issue.create';
      readonly ref?: string;
      readonly params: PmIssueCreateParams;
    }
  | {
      readonly type: 'issue.update';
      readonly params: {
        readonly issue: string;
        readonly set: PmIssueUpdateSet;
      };
    }
  | {
      readonly type: 'issue.status';
      readonly params: {
        readonly issue: PmIssueTarget;
        readonly statusKey: string;
      };
    }
  | {
      readonly type: 'dependency.add' | 'dependency.remove';
      readonly params: {
        readonly issue: PmIssueTarget;
        readonly blockedBy: PmIssueTarget;
      };
    }
  | {
      readonly type: 'comment.create';
      readonly params: {
        readonly issue: PmIssueTarget;
        readonly content: string;
        readonly parentId?: string;
        readonly internal?: boolean;
      };
    }
  | {
      readonly type: 'decision.resolve';
      readonly params: {
        readonly inboxItemId: string;
        readonly action: PmDecisionAction;
        readonly comment?: string;
      };
    }
  | {
      readonly type: 'project.create';
      readonly ref?: string;
      readonly params: {
        readonly name: string;
        readonly description?: string;
        readonly workflowTemplateId?: string;
        readonly visibility?: 'public' | 'private';
      };
    }
  | {
      readonly type: 'knowledge.propose';
      readonly params: AgentKnowledgeProposalRequest;
    };
export type PmOperationType = PmOperation['type'];

export const PM_OPERATION_TYPES = [
  'issue.create',
  'issue.update',
  'issue.status',
  'dependency.add',
  'dependency.remove',
  'comment.create',
  'decision.resolve',
  'project.create',
  'knowledge.propose',
] as const satisfies readonly PmOperationType[];

/** Why a direct write needs a plan card (409 `PLAN_REQUIRED`, `details.reason`, §3.2–3.3). */
export type PmPlanRequiredReason =
  | 'agentExecutor'
  | 'ownerChange'
  | 'terminal'
  | 'wouldStartRun'
  | 'planOnly'
  | 'budget'
  | 'confirmAll';

/** Distinct objects one conversation run may write directly (§3.3). */
export const PM_DIRECT_WRITE_LIMIT = 2;

export interface PmActRequest {
  readonly op: PmOperation;
}

export interface PmActBudget {
  readonly used: number;
  readonly limit: number;
}

export type PmObjectType =
  'issue' | 'project' | 'comment' | 'dependency' | 'knowledgeProposal';

/** `POST /np/agent/pm/act` → 200 */
export interface PmActResult {
  readonly op: PmOperationType;
  readonly object: {
    readonly type: PmObjectType;
    readonly id: string;
    readonly identifier?: string | null;
    readonly title?: string | null;
  };
  readonly budget: PmActBudget;
}

/** A run an operation would start (§3.4): computed by executing it and rolling back. */
export interface RunPreview {
  readonly agentId: string;
  readonly agentName: string | null;
  readonly issueId: string;
  readonly triggerType: string;
}

// ---------- Plan cards (§4) ----------

export type PmPlanStatus =
  | 'pending'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'discarded'
  | 'expired'
  | 'superseded';
export type PmPlanOpStatus = 'pending' | 'done' | 'failed' | 'removed';
export type PmPlanRowFlag =
  'startsRun' | 'terminal' | 'ownerChange' | 'decision' | 'createsProject';

export const PM_PLAN_MAX_OPS = 50;
export const PM_PLAN_TTL_HOURS = 24;
export const PM_PLAN_TITLE_MAX = 200;
export const PM_PLAN_SUMMARY_MAX = 2000;
export const PM_PLAN_REF_PATTERN = /^[a-z][a-z0-9_]{0,15}$/u;

export interface PmPlanRowCheck {
  readonly seq: number;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly preview: readonly RunPreview[];
  readonly flags: readonly PmPlanRowFlag[];
  /** `issue.update` / `issue.status`: the current values of the fields the row changes. */
  readonly baseline?: Readonly<Record<string, unknown>>;
}

export interface PmPlanRow extends PmPlanRowCheck {
  readonly ref: string | null;
  readonly type: PmOperationType;
  readonly params: unknown;
  readonly status: PmPlanOpStatus;
  readonly resultType?: string;
  readonly resultId?: string;
  readonly warnings: readonly string[];
}

export interface PmPlanResultRow {
  readonly seq: number;
  readonly type: PmOperationType;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly resultType?: string;
  readonly resultId?: string;
  readonly identifier?: string | null;
  readonly warnings: readonly string[];
}

export interface PmPlanResult {
  readonly status: 'executed' | 'failed';
  readonly rows: readonly PmPlanResultRow[];
}

export interface PmPlan {
  readonly id: string;
  readonly conversationId: string;
  readonly status: PmPlanStatus;
  readonly title: string;
  readonly summary: string | null;
  readonly revision: number;
  readonly expiresAt: string;
  /** pending, not expired, and every row ok */
  readonly executable: boolean;
  readonly rows: readonly PmPlanRow[];
  readonly result: PmPlanResult | null;
  readonly createdAt: string;
  readonly executedAt: string | null;
}

/** `POST /np/agent/pm/plans` */
export interface PmPlanCreateRequest {
  readonly title: string;
  readonly summary?: string;
  readonly ops: readonly PmOperation[];
}

/** `PATCH /np/pm/plans/:id`: edits existing rows only (no new rows). */
export interface PmPlanEditRequest {
  readonly revision: number;
  readonly ops: readonly {
    readonly seq: number;
    readonly params?: unknown;
    readonly removed?: boolean;
  }[];
}

/** The `planExecuted` trigger payload (§4.7), also `triggers[].plan` in the claim. */
export interface PmPlanExecutedPayload {
  readonly planId: string;
  readonly status: 'executed' | 'failed';
  readonly results: readonly PmPlanResultRow[];
}

// ---------- Conversations (§5) ----------

export type PmAgentSource = 'system' | 'personal' | 'fallback';
export type PmTitleSource = 'auto' | 'agent' | 'user';
export type PmCompat = 'ok' | 'deprecated' | 'upgrade_required';

export const PM_TITLE_AUTO_CHARS = 30;
export const PM_TITLE_MAX = 40;

export interface PmConversationAgent {
  readonly id: string;
  readonly name: string;
  readonly source: PmAgentSource;
  readonly online: boolean;
  readonly runtimeName: string | null;
  readonly compat: PmCompat;
  /** fallback: whether the personal agent can be restored */
  readonly personalAvailable: boolean;
}

export interface PmConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly lastMessageAt: string;
  readonly archivedAt: string | null;
  readonly agent: PmConversationAgent | null;
  readonly running: boolean;
  readonly pendingPlanCount: number;
}

export interface PmConversationDetail extends PmConversationSummary {
  readonly issueId: string;
  readonly identifier: string | null;
  readonly titleSource: PmTitleSource;
}

export interface PmConversationPage {
  readonly data: readonly PmConversationSummary[];
  readonly nextCursor: string | null;
}

/** `POST /np/pm/conversations` */
export interface PmConversationCreateRequest {
  readonly title?: string;
  readonly switchTo?: 'system' | 'personal';
}

/** `PATCH /np/pm/conversations/:id` */
export interface PmConversationPatch {
  readonly title?: string;
  readonly archived?: boolean;
}

/** `POST /np/agent/pm/conversation/title` */
export interface PmConversationTitleRequest {
  readonly title: string;
}

// ---------- System default and personal project managers (§6) ----------

export type PmAgentMode = 'system' | 'personal';

/** `GET/PATCH /np/me/preferences` (NP-108's `inboxChime` plus the project manager's, NP-183). */
export interface MemberPreferencesV5 {
  readonly inboxChime: boolean;
  readonly pmConfirmAll: boolean;
  readonly pmAgentMode: PmAgentMode;
  readonly pmAgentId: string | null;
  readonly revision: number;
}

export type PmAgentIneligibleReason =
  | 'personalDisabled'
  | 'notManager'
  | 'archived'
  | 'notOwner'
  | 'notPrivate'
  | 'foreignRuntime';

export interface PmAgentChoice {
  readonly mode: PmAgentMode;
  readonly agentId: string | null;
  readonly revision: number;
  readonly allowPersonal: boolean;
  readonly systemAgent: {
    readonly id: string;
    readonly name: string;
    readonly provider: string;
    readonly model: string | null;
    readonly online: boolean;
  } | null;
  readonly candidates: readonly {
    readonly id: string;
    readonly name: string;
    readonly provider: string;
    readonly model: string | null;
    readonly runtimeName: string | null;
    readonly online: boolean;
  }[];
  readonly eligibleRuntimes: readonly {
    readonly id: string;
    readonly name: string;
    readonly online: boolean;
    readonly shared: boolean;
  }[];
}

/** `PUT /np/me/pm-agent` */
export interface PmAgentChoiceRequest {
  readonly revision: number;
  readonly mode: PmAgentMode;
  readonly agentId?: string | null;
}

/** `POST /np/me/pm-agent/copy-from-default` */
export interface PmAgentCopyRequest {
  readonly runtimeId: string;
  readonly model?: string | null;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly name?: string;
}

// ---------- Roster (§7) ----------

export const AGENT_SUMMARY_MAX = 200;
export const PM_ROSTER_SUMMARY_FALLBACK = 300;
export const PM_RUN_EVENTS_MAX = 200;

export interface PmRosterAgent {
  readonly id: string;
  readonly name: string;
  readonly kind: 'coder' | 'manager';
  readonly provider: string;
  readonly model: string | null;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly summary: string;
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
  }[];
  readonly capabilities: readonly AgentCapability[];
  readonly runtime: {
    readonly id: string;
    readonly name: string;
    readonly online: boolean;
    readonly lastHeartbeatAt: string | null;
    readonly compat: PmCompat;
  } | null;
  readonly load: {
    readonly running: number;
    readonly queued: number;
    readonly maxConcurrentRuns: number;
  };
  readonly stats30d: {
    readonly runs: number;
    readonly failed: number;
    readonly doneIssues: number;
  };
  readonly canInvoke: boolean;
  readonly delegation: readonly string[];
}

// ---------- Page context (§8) ----------

export type PmContextItemType =
  | 'issue'
  | 'project'
  | 'knowledgeDoc'
  | 'inboxItem'
  | 'run'
  | 'agent'
  | 'pullRequest';

export const PM_CONTEXT_ROUTE_MAX = 500;
export const PM_CONTEXT_ITEMS_MAX = 10;
export const PM_CONTEXT_FILTER_KEYS_MAX = 20;
export const PM_CONTEXT_SELECTION_MAX = 2000;

export interface PmPageContext {
  readonly route: string;
  readonly items: readonly {
    readonly type: PmContextItemType;
    readonly id: string;
  }[];
  readonly filter?: {
    readonly page: 'issues' | 'board' | 'inbox' | 'knowledge';
    readonly params: Readonly<Record<string, string>>;
  };
  readonly selection?: {
    readonly text: string;
    readonly sourceType?: PmContextItemType;
    readonly sourceId?: string;
  };
}

/** `comments.context` and `triggers[].comment.context`: the items the author may see, with their labels. */
export interface PmResolvedContext {
  readonly route: string;
  readonly items: readonly {
    readonly type: PmContextItemType;
    readonly id: string;
    readonly identifier: string | null;
    readonly title: string;
  }[];
  readonly filter?: PmPageContext['filter'];
  readonly selection?: PmPageContext['selection'];
}

// ---------- Claim (§9.1) ----------

export interface PmAskerSummary {
  readonly userId: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly ownedOpen: number;
  readonly ownedInProgress: number;
  readonly pendingDecisions: number;
  readonly locale: string | null;
}

/** `issue.conversation` of a claimed conversation run. */
export interface ClaimedConversation {
  readonly id: string;
  readonly agentSource: PmAgentSource;
  readonly confirmAll: boolean;
  readonly budget: PmActBudget;
  readonly asker: PmAskerSummary;
}

/** `GET /np/agent/issues/:id/attachments/:fileId/text` (NP-183, replaces contract §8.4's `extractedText`). */
export interface AttachmentTextResponse {
  readonly text: string | null;
}
