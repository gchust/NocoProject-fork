/**
 * Wires every NocoProject module service from its dependencies.
 *
 * The provider (`server/providers/np.ts`) binds these to container tokens; tests build them directly against a real
 * database. Cross-module references that would form a cycle (issue → trigger → run → trigger for retries) are
 * resolved lazily through the `services` object. The transaction runner hands every transaction's domain events,
 * before commit (`shared/db.ts`), first to the approval gate (a status that moved cancels stale requests) and then to
 * the notification module.
 *
 * Iteration 2 adds the injectable edges tests replace: the secret box, the GitHub client, the AI intake parser and
 * the approval gateway (the "replacement checklist" test runs the suite with an in-memory gateway). Iteration 3 adds the
 * knowledge base, the acceptance metrics and the delivery decisions (`createIteration3Services`); iteration 4 the
 * process classifier, the design decisions and the project manager (`services.iter4.ts`).
 */
import type { DatabaseManager } from '@nocobase/db';
import type { IdGeneratorService } from '@nocobase/snowflake';

import {
  createAgentService,
  type AgentService,
} from './agent/agent.service.js';
import { type AgentEnvService } from './agent/env.service.js';
import { type ReactionService } from './collaboration/reaction.service.js';
import { type GitConnectionService } from './git/connection.service.js';
import {
  createFetchGitHubClient,
  type GitHubClient,
} from './git/github-client.js';
import { type PullRequestService } from './git/pull-request.service.js';
import { type WebhookService } from './git/webhook.service.js';
import type { AiIntakeParser } from './intake/ai-parser.js';
import type { AiProcessClassifier } from './intake/process-classifier.js';
import {
  buildProcessClassifier,
  createIteration4Services,
  type Iteration4Services,
} from './services.iter4.js';
import { type IntakeService } from './intake/intake.service.js';
import { type DeliveryService } from './issue/delivery.service.js';
import { findIssue } from './issue/issue.records.js';
import { type KnowledgeService } from './knowledge/knowledge.service.js';
import { type MetricsService } from './metrics/metrics.service.js';
import type { ApprovalGateway, ApprovalHooks } from './shared/approval.js';
import { resolveApproverIds } from './shared/authz.js';
import {
  createSecretBox,
  resolveSecretKey,
  type SecretBox,
} from './shared/crypto.js';
import type { Tx } from './shared/db.js';
import type { DomainEvent } from './shared/events.js';
import { type SkillService } from './skill/skill.service.js';
import { type WorkspaceSettingsService } from './system/settings.admin.js';
import { type UsageService } from './usage/usage.service.js';
import {
  createCommentService,
  type CommentService,
} from './collaboration/comment.service.js';
import {
  createLabelService,
  type LabelService,
} from './label/label.service.js';
import {
  createMemberService,
  type MemberService,
} from './member/member.service.js';
import type { RoleAssignments, RoleStore } from './member/member.roles.js';
import { createRoleService, type RoleService } from './member/roles.service.js';
import {
  createInvitationService,
  type InvitationAccounts,
  type InvitationService,
} from './member/invitation.service.js';
import {
  createDaemonWakeups,
  type DaemonWakeups,
} from './runtime/daemon-wakeups.js';
import {
  createComputerService,
  type ComputerKeys,
  type ComputerService,
} from './computer/computer.service.js';
import {
  unconfiguredMailer,
  type InvitationMailer,
} from './member/invitation.mail.js';
import {
  createInboxService,
  type InboxService,
} from './notification/inbox.service.js';
import {
  createNotificationService,
  type NotificationService,
} from './notification/notification.service.js';
import {
  createAgentIssueService,
  type AgentIssueService,
} from './subtask/agent-issue.service.js';
import {
  createDependencyService,
  type DependencyService,
} from './subtask/dependency.service.js';
import {
  createProposalService,
  type ProposalService,
} from './subtask/proposal.service.js';
import {
  createWorkflowService,
  type WorkflowService,
} from './workflow/workflow.service.js';
import {
  createChecklistService,
  type ChecklistService,
} from './workflow/checklist.js';
import {
  createWorkflowProposalService,
  type WorkflowProposalService,
} from './workflow/workflow.proposals.js';
import {
  createIssueQueries,
  type IssueQueries,
} from './issue/issue.queries.js';
import {
  createIssueService,
  type IssueService,
} from './issue/issue.service.js';
import {
  createProjectService,
  type ProjectService,
} from './project/project.service.js';
import type { ClaimService } from './run/claim.service.js';
import type { RunRecoveryService } from './run/failure.js';
import type { RunEventService } from './run/run-events.js';
import type { RunQueries } from './run/run.queries.js';
import type { RunService } from './run/run.service.js';
import type { SweeperService } from './run/sweeper.js';
import type { RunTokenService } from './run/token.js';
import { createRunModules } from './services.runs.js';
import {
  createIteration2Services,
  createIteration3Services,
} from './services.iter2.js';
import {
  createRuntimeService,
  type RuntimeService,
} from './runtime/runtime.service.js';
import { createActivityRecorder } from './shared/activity.js';
import { createTxRunner, type TxRunner } from './shared/db.js';
import { createDomainEventBus, type DomainEventBus } from './shared/events.js';
import { createIdSource } from './shared/ids.js';
import { createUserDirectory } from './shared/users.js';
import { conflict } from './shared/errors.js';
import {
  createSettingsService,
  type SettingsService,
} from './system/settings.service.js';
import {
  createTriggerService,
  type TriggerService,
} from './trigger/trigger.service.js';

import type { AttachmentTextReader } from './attachment/attachment-text.js';
import {
  createAttachmentService,
  type AttachmentService,
  type FileObjectStore,
} from './attachment/attachment.service.js';

export interface NpServices {
  readonly bus: DomainEventBus;
  readonly tx: TxRunner;
  readonly settings: SettingsService;
  readonly workflows: WorkflowService;
  readonly members: MemberService;
  readonly labels: LabelService;
  readonly dependencies: DependencyService;
  readonly proposals: ProposalService;
  readonly agentIssues: AgentIssueService;
  readonly inbox: InboxService;
  readonly notifications: NotificationService;
  readonly projects: ProjectService;
  readonly issues: IssueService;
  readonly issueQueries: IssueQueries;
  readonly comments: CommentService;
  readonly agents: AgentService;
  readonly runtimes: RuntimeService;
  readonly triggers: TriggerService;
  readonly runs: RunService;
  readonly runRecovery: RunRecoveryService;
  readonly runEvents: RunEventService;
  readonly runQueries: RunQueries;
  readonly claims: ClaimService;
  readonly runTokens: RunTokenService;
  readonly sweeper: SweeperService;
  // Iteration 2.
  readonly approvals: ApprovalGateway;
  readonly gitConnections: GitConnectionService;
  readonly pullRequests: PullRequestService;
  readonly webhooks: WebhookService;
  readonly intake: IntakeService;
  readonly reactions: ReactionService;
  readonly agentEnv: AgentEnvService;
  readonly skills: SkillService;
  readonly usage: UsageService;
  readonly workspaceSettings: WorkspaceSettingsService;
  // Iteration 3.
  readonly knowledge: KnowledgeService;
  readonly metrics: MetricsService;
  readonly deliveries: DeliveryService;
  // Iteration 4.
  readonly design: Iteration4Services['design'];
  readonly pm: Iteration4Services['pm'];
  readonly pmConversations: Iteration4Services['pmConversations'];
  readonly pmAgents: Iteration4Services['pmAgents'];
  readonly pmAct: Iteration4Services['pmAct'];
  readonly pmPlans: Iteration4Services['pmPlans'];
  readonly pullRequestMerges: Iteration4Services['pullRequestMerges'];
  // Phase 2 (NP-77).
  readonly checklists: ChecklistService;
  readonly workflowProposals: WorkflowProposalService;
  // NP-78.
  readonly attachments: AttachmentService;
  // NP-88.
  readonly invitations: InvitationService;
  // NP-150.
  readonly computers: ComputerService;
  readonly daemonWakeups: DaemonWakeups;
  // NP-153.
  readonly businessRoles: RoleService;
}

/** What an alternative approval gateway gets to build itself (tests: the in-memory double). */
export interface ApprovalGatewayContext {
  readonly tx: TxRunner;
  readonly hooks: () => ApprovalHooks;
}

export interface NpServiceDeps {
  readonly database: DatabaseManager;
  readonly idGenerator: IdGeneratorService;
  readonly bus?: DomainEventBus;
  /** Defaults to a random process-local key (tests); the provider passes the configured one. */
  readonly secrets?: SecretBox;
  /** Defaults to the fetch-based client. */
  readonly github?: GitHubClient;
  /** The AI intake parser; null or absent = heuristic only. */
  readonly aiIntake?: AiIntakeParser | null;
  /** Whether an LLM service is configured (`ai.llmServices` not empty). */
  readonly aiConfigured?: () => boolean;
  /** Iteration 4: the AI process classifier; null or absent = heuristic only. */
  readonly aiProcess?: AiProcessClassifier | null;
  /** NP-78: deletes stored attachment objects; the provider backs it with Drive. Absent = objects are kept (tests). */
  readonly fileObjects?: FileObjectStore;
  readonly onFileObjectError?: (error: unknown) => void;
  /** NP-78: reads files attached on the AI draft tab (np.newIssue.tabs.ai) for the AI parser; absent = files are not read. */
  readonly attachmentText?: AttachmentTextReader | null;
  /** NP-88: invitation email and account creation; absent = no email is sent, no account can be created. */
  readonly mailer?: () => InvitationMailer;
  readonly accounts?: () => InvitationAccounts | null;
  /** NP-150: the computer credential store; the provider backs it with the API Keys plugin. Absent = none can be issued. */
  readonly computerKeys?: () => ComputerKeys;
  /**
   * NP-117: where member roles are stored. The provider backs it with the built-in permission sets; the service tests
   * pass a double over `members.role`.
   */
  readonly roles: () => RoleAssignments;
  /**
   * NP-153: the permission sets behind the business roles of `/config/members`. Absent (service tests) = role
   * management answers 409 `ROLES_UNAVAILABLE`.
   */
  readonly roleStore?: () => RoleStore;
  /** Replaces the database approval gateway (the replacement checklist test). */
  readonly approvalGateway?: (
    context: ApprovalGatewayContext,
  ) => ApprovalGateway;
}

/** A status that moved (or became terminal) cancels the issue's stale approval requests. */
async function cancelStaleApprovals(
  services: NpServices,
  tx: Tx,
  events: readonly DomainEvent[],
): Promise<void> {
  for (const event of events) {
    if (event.type !== 'issue.updated' || !event.changes.status) continue;
    const issue = await findIssue(tx.conn, event.issueId);
    if (!issue) continue;
    const view = await services.workflows.forIssue(tx.conn, issue);
    await services.approvals.cancelStale(
      tx,
      issue.id,
      issue.statusKey,
      view.isTerminal(issue.statusKey),
    );
  }
}

/** What the approval gateway calls back into (applying an approved transition, resolving approvers). */
function approvalHooksOf(
  services: NpServices,
  roles: NpServiceDeps['roles'],
): ApprovalHooks {
  return {
    applyTransition: (unit, request, approver) =>
      services.issues.applyApprovedTransition(unit, request, approver),
    resolveApprovers: (unit, issue, approverRoles) =>
      resolveApproverIds(unit.conn, roles(), issue, approverRoles),
  };
}

export function createNpServices(deps: NpServiceDeps): NpServices {
  // Filled in below; the lazy getters are only called at request time, after construction completes.
  const services = {} as { -readonly [K in keyof NpServices]: NpServices[K] };

  const bus = deps.bus ?? createDomainEventBus();
  const tx = createTxRunner(deps.database, bus, async (unit, events) => {
    await cancelStaleApprovals(services, unit, events);
    await services.notifications.process(unit, events);
  });
  const secrets = deps.secrets ?? createSecretBox(resolveSecretKey({}));
  const github = deps.github ?? createFetchGitHubClient();
  const approvalHooks = () => approvalHooksOf(services, deps.roles);
  const ids = createIdSource(deps.idGenerator);
  const users = createUserDirectory();
  const activity = createActivityRecorder(ids);
  const settings = createSettingsService();
  const workflows = createWorkflowService({ tx });

  Object.assign(services, {
    bus,
    tx,
    settings,
    workflows,
    members: createMemberService({ tx, ids, roles: deps.roles }),
    labels: createLabelService({ tx, ids }),
    dependencies: createDependencyService({
      tx,
      ids,
      activity,
      triggers: () => services.triggers,
    }),
    proposals: createProposalService({
      tx,
      ids,
      activity,
      issues: () => services.issues,
    }),
    agentIssues: createAgentIssueService({
      tx,
      ids,
      activity,
      workflows,
      issues: () => services.issues,
      queries: () => services.issueQueries,
      triggers: () => services.triggers,
    }),
    inbox: createInboxService({ tx, ids }),
    notifications: createNotificationService({ ids, users, workflows }),
    projects: createProjectService({ tx, ids, users, activity, workflows }),
    issues: createIssueService({
      tx,
      ids,
      users,
      activity,
      settings,
      workflows,
      triggers: () => services.triggers,
      approvals: () => services.approvals,
      classifier: buildProcessClassifier(deps.aiProcess, deps.aiConfigured),
    }),
    issueQueries: createIssueQueries({
      tx,
      users,
      workflows,
      settings,
      comments: () => services.comments,
      approvals: () => services.approvals,
    }),
    comments: createCommentService({
      tx,
      ids,
      users,
      activity,
      triggers: () => services.triggers,
      conversations: () => services.pmConversations,
    }),
    agents: createAgentService({ tx, ids, users, activity }),
    runtimes: createRuntimeService({ tx, ids, users }),
    triggers: createTriggerService({
      runs: () => services.runs,
      workflows,
      activity,
      settings,
      ids,
      users,
    }),
    ...createRunModules(
      { tx, ids, users, activity, workflows, secrets },
      services,
    ),
    ...createIteration2Services(
      { deps, tx, ids, users, activity, settings, workflows, secrets, github },
      services,
      approvalHooks,
    ),
    ...createIteration3Services(
      { tx, ids, users, activity, settings, workflows, roles: deps.roles },
      services,
    ),
    ...createIteration4Services(
      {
        tx,
        ids,
        secrets,
        github,
        users,
        activity,
        settings,
        workflows,
        roles: deps.roles,
      },
      services,
    ),
    checklists: createChecklistService({ tx, ids, users, activity }),
    workflowProposals: createWorkflowProposalService({
      tx,
      ids,
      users,
      activity,
      workflows,
      roles: deps.roles,
    }),
    attachments: createAttachmentService({
      tx,
      users,
      activity,
      objects: deps.fileObjects ?? { remove: async () => undefined },
      onObjectError: deps.onFileObjectError,
      text: deps.attachmentText ?? null,
    }),
    invitations: createInvitationService({
      tx,
      ids,
      users,
      mailer: deps.mailer ?? (() => unconfiguredMailer),
      accounts: deps.accounts ?? (() => null),
      roles: deps.roles,
    }),
    daemonWakeups: createDaemonWakeups(bus),
    computers: createComputerService({
      tx,
      ids,
      users,
      keys: lazyComputerKeys(deps.computerKeys),
    }),
    businessRoles: createRoleService({
      tx,
      ids,
      roles: deps.roles,
      store: deps.roleStore ?? unavailableRoles,
    }),
  } satisfies NpServices);

  return services;
}

function unavailableRoles(): never {
  throw conflict(
    'ROLES_UNAVAILABLE',
    'Business roles need the built-in authorization.',
  );
}

/** Resolves the key store at request time (the plugin is registered after this service is built). */
function lazyComputerKeys(
  factory: (() => ComputerKeys) | undefined,
): ComputerKeys {
  const store = (): ComputerKeys => {
    if (!factory) throw new Error('Computer credentials are not configured.');
    return factory();
  };
  return {
    create: (conn, input) => store().create(conn, input),
    verify: (secret) => store().verify(secret),
    disable: (conn, keyId) => store().disable(conn, keyId),
  };
}
