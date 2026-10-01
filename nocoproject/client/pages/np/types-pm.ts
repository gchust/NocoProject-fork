import type { IssuePriority } from './types.js';
import type {
  BuiltinStatusReason,
  RuntimeType,
} from './types-runtime-types.js';

/**
 * Project manager 2.0 (`nocosolution/NocoProject/docs/phase2/protocol-pm-assistant.md`, NP-181): the browser side of
 * multiple conversations (§5.4), the conversation's agent and its fallback (§5.6, §6.5), the member's choice (§6.2),
 * page context (§8) and operation plans (§4). Copied from the contract rather than imported (see `types.ts`); keep
 * it in step with `server/modules/shared/protocol.phase2-pm-assistant.ts` once the server lands it.
 *
 * The shapes follow the server's `server/modules/shared/protocol.phase2-pm-assistant.ts` as NP-183 implemented them
 * (the departures are listed in the contract's change log): a conversation's `agent` is null when no project manager
 * can take it, a new conversation's title is empty until its first message, and a plan names the comment it belongs
 * to (`commentId`) because comments carry no `details`.
 */

// §8.1 page context -------------------------------------------------------------------------------------------------

export type PmContextItemType =
  | 'issue'
  | 'project'
  | 'knowledgeDoc'
  | 'inboxItem'
  | 'run'
  | 'agent'
  | 'pullRequest';

export type PmFilterPage = 'issues' | 'board' | 'inbox' | 'knowledge';

export interface PmPageContext {
  /** pathname + search, ≤ 500 characters. */
  readonly route: string;
  /** ≤ 10. */
  readonly items: readonly {
    readonly type: PmContextItemType;
    readonly id: string;
  }[];
  /** ≤ 20 keys. */
  readonly filter?: {
    readonly page: PmFilterPage;
    readonly params: Readonly<Record<string, string>>;
  };
  /** text ≤ 2000 characters. */
  readonly selection?: {
    readonly text: string;
    readonly sourceType?: PmContextItemType;
    readonly sourceId?: string;
  };
}

/** §8.2: what the server stored on the comment, items filtered to what the author may see. */
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

// §5.4 conversations ------------------------------------------------------------------------------------------------

/** §6.3: why an agent cannot be the member's personal project manager (`PM_AGENT_NOT_ELIGIBLE`, `details.reason`). */
export type PmAgentIneligibleReason =
  | 'personalDisabled'
  | 'notManager'
  | 'archived'
  | 'notOwner'
  | 'notPrivate'
  | 'foreignRuntime';

export type PmAgentSource = 'system' | 'personal' | 'fallback';
export type PmRuntimeCompat = 'ok' | 'deprecated' | 'upgrade_required';

export interface PmConversationAgent {
  readonly id: string;
  readonly name: string;
  readonly source: PmAgentSource;
  readonly online: boolean;
  readonly runtimeName: string | null;
  readonly compat: PmRuntimeCompat;
  /** In fallback: whether the personal agent may be restored. */
  readonly personalAvailable: boolean;
  /** NP-219: absent from a server without runtime types, which means computer. */
  readonly runtimeType?: RuntimeType;
  /** Why a built-in agent's runtime is offline (null while online and for computer agents). */
  readonly statusReason?: BuiltinStatusReason | null;
}

export interface PmConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly lastMessageAt: string;
  readonly archivedAt: string | null;
  /** Null when no project manager can take the conversation. */
  readonly agent: PmConversationAgent | null;
  readonly running: boolean;
  readonly pendingPlanCount: number;
}

export interface PmConversationDetail extends PmConversationSummary {
  readonly issueId: string;
  readonly identifier: string | null;
  readonly titleSource: 'auto' | 'agent' | 'user';
}

export interface PmConversationPage {
  readonly data: readonly PmConversationSummary[];
  readonly nextCursor: string | null;
}

// §6.2 the member's choice ------------------------------------------------------------------------------------------

export interface PmAgentChoice {
  readonly mode: 'system' | 'personal';
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

// §4 operation plans ------------------------------------------------------------------------------------------------

export type PmExecutorInput =
  | { readonly type: 'none' }
  | { readonly type: 'user' | 'agent'; readonly id: string };

/** `issue`: an id or an identifier; `ref`: an earlier row of the same plan. */
export type PmIssueRef = { readonly issue: string } | { readonly ref: string };

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
        readonly issue: string | PmIssueRef;
        readonly statusKey: string;
      };
    }
  | {
      readonly type: 'dependency.add' | 'dependency.remove';
      readonly params: {
        readonly issue: string | PmIssueRef;
        readonly blockedBy: string | PmIssueRef;
      };
    }
  | {
      readonly type: 'comment.create';
      readonly params: {
        readonly issue: string | PmIssueRef;
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
    };

export type PmOperationType = PmOperation['type'];

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

/** A run the row would start once executed (§3.4 `previewRuns`). */
export interface RunPreview {
  readonly agentId: string;
  readonly agentName: string | null;
  readonly issueId: string;
  readonly triggerType: string;
}

export interface PmPlanRow {
  readonly seq: number;
  readonly ref: string | null;
  readonly type: PmOperationType;
  readonly params: unknown;
  readonly status: PmPlanOpStatus;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly preview: readonly RunPreview[];
  readonly flags: readonly PmPlanRowFlag[];
  readonly baseline?: Readonly<Record<string, unknown>>;
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
  /** Pending, not expired, and every row ok. */
  readonly executable: boolean;
  readonly rows: readonly PmPlanRow[];
  readonly result: PmPlanResult | null;
  readonly createdAt: string;
  readonly executedAt: string | null;
  /** The conversation's `kind = 'plan'` comment that shows this plan. */
  readonly commentId?: string | null;
}

/** `PATCH /np/pm/plans/:id` */
export interface PmPlanEdit {
  readonly revision: number;
  readonly ops: readonly {
    readonly seq: number;
    readonly params?: unknown;
    readonly removed?: boolean;
  }[];
}

// Error codes the browser tells apart (§12) --------------------------------------------------------------------------

export const PM_ERROR = {
  notConfigured: 'PM_NOT_CONFIGURED',
  planNotPending: 'PLAN_NOT_PENDING',
  planExpired: 'PLAN_EXPIRED',
  revisionConflict: 'REVISION_CONFLICT',
  invalidRef: 'INVALID_REF',
  notPersonal: 'NOT_PERSONAL',
  personalUnavailable: 'PERSONAL_UNAVAILABLE',
  invalidContext: 'INVALID_CONTEXT',
} as const;
