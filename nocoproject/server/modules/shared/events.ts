// @temporary(nocobase-official): to be replaced by the official NocoBase activity stream and change events
/**
 * In-process domain event bus.
 *
 * Services record what changed; subscribers (today only the realtime bridge) turn that into side effects. Events are
 * emitted after the owning transaction commits (see `shared/db.ts`), so a subscriber never observes a change that
 * is later rolled back. Delivery is synchronous, in-process and best-effort: a failing subscriber is logged and does
 * not affect the caller or the other subscribers. It does not survive a restart and does not cross instances.
 *
 * Before the commit, the same events are handed to the notification module inside the transaction (the
 * `beforeCommit` hook of `createTxRunner`); the `issue.*`, `comment.*`, `proposal.*` and `run.failed` events below
 * exist for it, and so do the iteration 2 `approval.*` and `pr.*` events. The inbox they feed is not temporary; only
 * this bus is.
 */
import type {
  DependencyType,
  ExecutorType,
  ProposalSource,
  RunStatus,
  StageActionType,
  WorkflowProposalKind,
} from './protocol.js';

/** Who caused an event, in serializable form. */
export interface EventActor {
  readonly type: 'user' | 'agent' | 'system';
  readonly id: string | null;
}

export interface ExecutorRef {
  readonly type: ExecutorType;
  readonly id: string | null;
}

/** What one issue write changed, for the notification module. */
export interface IssueChangeSet {
  readonly status?: { readonly from: string; readonly to: string };
  readonly owner?: { readonly from: string | null; readonly to: string | null };
  readonly executor?: { readonly from: ExecutorRef; readonly to: ExecutorRef };
  /** Users newly mentioned in the description. */
  readonly mentionedUserIds?: readonly string[];
}

export type DomainEvent =
  | { readonly type: 'issue.changed'; readonly issueId: string }
  | {
      readonly type: 'run.status';
      readonly runId: string;
      readonly issueId: string;
      readonly status: RunStatus;
    }
  | {
      readonly type: 'run.events';
      readonly runId: string;
      readonly last: number;
    }
  | { readonly type: 'agents.changed' }
  | {
      /** NP-150: a daemon's runtimes entered or left `upgrade_required` (the owner's inbox). */
      readonly type: 'runtime.compatibilityChanged';
      readonly ownerUserId: string;
      readonly daemonId: string;
      readonly deviceName: string | null;
      readonly upgradeRequired: boolean;
      readonly daemonVersion: string | null;
      readonly latestVersion: string;
      readonly reason: string;
    }
  | {
      readonly type: 'daemon.workAvailable';
      readonly userId: string;
      readonly runtimeId: string;
    }
  | {
      readonly type: 'daemon.cancelRequested';
      readonly userId: string;
      readonly runId: string;
    }
  | {
      readonly type: 'issue.created';
      readonly issueId: string;
      readonly actor: EventActor;
      readonly mentionedUserIds: readonly string[];
    }
  | {
      readonly type: 'issue.updated';
      readonly issueId: string;
      readonly actor: EventActor;
      readonly changes: IssueChangeSet;
    }
  | {
      readonly type: 'comment.created';
      readonly issueId: string;
      readonly commentId: string;
      readonly actor: EventActor;
      readonly mentionedUserIds: readonly string[];
    }
  | {
      readonly type: 'run.failed';
      readonly runId: string;
      readonly issueId: string;
      readonly agentId: string;
      readonly reason: string;
      /** No retry was scheduled. */
      readonly final: boolean;
    }
  | {
      readonly type: 'proposal.created';
      readonly proposalId: string;
      readonly issueId: string;
      /** The issue whose card lists the proposal's parent; null for workflow suggestions (their own issue). */
      readonly parentIssueId: string | null;
      /** Null for workflow suggestions (Phase 2). */
      readonly proposedByAgentId: string | null;
      readonly proposedAgentId: string;
      readonly source?: ProposalSource;
    }
  | {
      readonly type: 'proposal.decided';
      readonly proposalId: string;
      readonly issueId: string;
      readonly parentIssueId: string | null;
      readonly actor: EventActor;
    }
  | {
      readonly type: 'issue.batchDone';
      readonly parentIssueId: string;
      readonly stage: number | null;
      readonly childIssueIds: readonly string[];
    }
  | {
      readonly type: 'issue.dependencyReleased';
      readonly issueId: string;
      readonly releasedBy: string;
    }
  | {
      readonly type: 'issue.dependencyChanged';
      readonly issueId: string;
      readonly dependsOnIssueId: string;
      readonly dependencyType: DependencyType;
      readonly added: boolean;
    }
  | { readonly type: 'inbox.changed'; readonly userId: string }
  // Iteration 2 (docs/phase1/iteration-2-contract.md §C, §D).
  | {
      readonly type: 'approval.requested';
      readonly requestId: string;
      readonly issueId: string;
      readonly fromStatus: string;
      readonly toStatus: string;
      readonly approverUserIds: readonly string[];
      readonly actor: EventActor;
    }
  | {
      readonly type: 'approval.decided';
      readonly requestId: string;
      readonly issueId: string;
      readonly status: 'approved' | 'rejected' | 'cancelled';
      readonly fromStatus: string;
      readonly toStatus: string;
      readonly requestedBy: EventActor;
      /** The approver; system for a cancellation. */
      readonly actor: EventActor;
      readonly comment: string | null;
    }
  | {
      readonly type: 'pr.reviewRequested';
      readonly issueId: string;
      readonly pullRequestId: string;
      readonly repo: string;
      readonly number: number;
      readonly url: string;
    }
  | {
      /** A PR was merged or closed: its `pr_review` cards resolve. */
      readonly type: 'pr.closed';
      readonly issueIds: readonly string[];
      readonly merged: boolean;
    }
  | {
      readonly type: 'pr.merged';
      readonly issueId: string;
      readonly repo: string;
      readonly number: number;
      readonly url: string;
      /** The status the merge moved the issue to, or null when it did not change it. */
      readonly statusChangedTo: string | null;
    }
  // Iteration 3 (docs/phase1/iteration-3-contract.md §B, §E). Knowledge events carry everything the inbox payload
  // needs, so the notification module never reads the knowledge tables.
  | {
      readonly type: 'knowledge.proposed';
      readonly proposalId: string;
      readonly docId: string | null;
      readonly docTitle: string;
      readonly projectId: string | null;
      readonly projectName: string | null;
      readonly reason: string;
      readonly summary: string;
      readonly isNew: boolean;
      /** The source issue (the card is shown on it); null skips the card. */
      readonly issueId: string | null;
      readonly deciderUserIds: readonly string[];
      readonly actor: EventActor;
    }
  | {
      readonly type: 'knowledge.decided';
      readonly proposalId: string;
      readonly docId: string | null;
      readonly docTitle: string;
      readonly decision: 'accepted' | 'rejected';
      /** The document version the acceptance produced (null when rejected). */
      readonly version: number | null;
      readonly comment: string | null;
      readonly issueId: string | null;
      readonly actor: EventActor;
    }
  | {
      /** A member accepted a delivery or asked for changes: the issue's `review_requested` cards resolve. */
      readonly type: 'delivery.decided';
      readonly issueId: string;
      readonly decision: 'accepted' | 'changesRequested';
      readonly actor: EventActor;
    }
  // Iteration 4 (docs/phase1/iteration-4-contract.md §B).
  | {
      /** An agent submitted a design proposal: refreshes an open `design_review` card. */
      readonly type: 'design.proposed';
      readonly issueId: string;
      readonly commentId: string;
      readonly actor: EventActor;
    }
  | {
      /** A member approved the design or sent it back: the issue's `design_review` cards resolve. */
      readonly type: 'design.decided';
      readonly issueId: string;
      readonly decision: 'approved' | 'changesRequested';
      readonly actor: EventActor;
    }
  // Phase 2 workflow stage actions (NP-77).
  | {
      /** A `notifyOwner` stage action: the issue entered `to`. */
      readonly type: 'issue.stageEntered';
      readonly issueId: string;
      readonly from: string;
      readonly to: string;
      readonly message: string | null;
      readonly actor: EventActor;
    }
  | {
      /** A stage action was skipped, failed or suppressed by the loop guard: the owner is told. */
      readonly type: 'issue.stageActionReported';
      readonly issueId: string;
      readonly statusKey: string;
      readonly action: StageActionType;
      readonly outcome: 'skipped' | 'failed' | 'suppressed';
      /** The skip reason or the error message. */
      readonly reason: string | null;
    }
  | {
      /** An approved transition no longer met its entry conditions: the request was cancelled as stale. */
      readonly type: 'approval.stale';
      readonly requestId: string;
      readonly issueId: string;
      readonly fromStatus: string;
      readonly toStatus: string;
      readonly approverUserIds: readonly string[];
      readonly requestedBy: EventActor;
      readonly code: string;
      readonly message: string;
      readonly actor: EventActor;
    }
  // Phase 2 workflow template proposals (NP-77 stage 2). They carry what the inbox payload needs, so the notification
  // module never reads the proposal tables.
  | {
      /** An agent proposed a template change: `workflow_proposal` decision cards for the owner/admins. */
      readonly type: 'workflow.proposed';
      readonly proposalId: string;
      readonly kind: WorkflowProposalKind;
      /** The edited template; null for a copy. */
      readonly templateId: string | null;
      /** The edited template's name, or the copy's proposed name. */
      readonly templateName: string;
      readonly copyFromId: string | null;
      readonly reason: string;
      /** Counts of the structured diff, for the card. */
      readonly changes: Readonly<Record<string, number>>;
      /** The source issue (the card is shown on it); null skips the card. */
      readonly issueId: string | null;
      readonly deciderUserIds: readonly string[];
      readonly actor: EventActor;
    }
  | {
      /** The proposal was accepted, rejected, or found stale on acceptance: its cards resolve, the owner is told. */
      readonly type: 'workflow.decided';
      readonly proposalId: string;
      readonly kind: WorkflowProposalKind;
      readonly templateId: string | null;
      readonly templateName: string;
      readonly decision: 'accepted' | 'rejected' | 'stale';
      /** The revision the acceptance produced (null otherwise). */
      readonly revision: number | null;
      readonly comment: string | null;
      readonly issueId: string | null;
      readonly actor: EventActor;
    }
  | {
      /** A template got a new definition (an accepted proposal, or the admin `PUT`). */
      readonly type: 'workflow.changed';
      readonly templateId: string;
      readonly revision: number;
      readonly actor: EventActor;
    };

export type DomainEventListener = (event: DomainEvent) => void;

export interface DomainEventBus {
  emit(event: DomainEvent): void;
  subscribe(listener: DomainEventListener): () => void;
}

export function createDomainEventBus(
  onError: (error: unknown, event: DomainEvent) => void = (error) =>
    console.error('NocoProject domain event listener failed.', error),
): DomainEventBus {
  const listeners = new Set<DomainEventListener>();
  return {
    emit(event) {
      for (const listener of Array.from(listeners)) {
        try {
          listener(event);
        } catch (error) {
          onError(error, event);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
