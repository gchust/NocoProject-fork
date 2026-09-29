/**
 * NocoProject provider: binds every module service to its token, connects domain events to realtime topics and runs
 * the run sweeper every 30 seconds (which also purges old webhook delivery records and, since NP-78, attachment uploads
 * never attached to an issue within a day).
 *
 * Iteration 2: the secret key for stored secrets comes from the `nocoproject` configuration section
 * (`NOCOPROJECT_SECRET_KEY`), falling back to a key derived from `auth.secret` with a warning; the AI intake parser is
 * built from the AI employee plugin's agent factory when that plugin is registered.
 *
 * Iteration 3 (docs/phase1/iteration-3-contract.md §A, §G): the settings items `np-members`, `np-settings` and
 * `np-github` are no longer registered — settings moved into the application's own `/config` page (page `np-config`).
 *
 * NP-117: member roles are the built-in permission sets `np-owner` / `np-admin` / `np-member`, and each `/config` tab is
 * a settings item `nocoproject.*` checked by its API (`np-authorization.ts`, `shared/access.ts`). The provider registers
 * them in `boot`, and keeps the `members.role` projection in step at start and whenever assignments change.
 *
 * Page grants for the NocoProject pages are given to the default `member` permission set once, by the seeds
 * `2026092800003_np_member_page_grants`, `2026092900003_np_iter2_page_grants`, `2026092900004_np_github_settings_grant`
 * and `2026093000002_np_iter3_page_grants`, so administrators can still edit them.
 */
import { Readable } from 'node:stream';

import {
  aiManagerToken,
  type AIApplicationConfig,
} from '@nocobase/app-plugin-ai-employee/server';
import type { AuthConfig } from '@nocobase/app-plugin-authentication/server';
import type { Application } from '@nocobase/app-server/application';
import { driveManagerToken } from '@nocobase/app-server/drive';
import { idGeneratorToken } from '@nocobase/app-server/id-generator';
import { loggingToken } from '@nocobase/app-server/logging';
import { realtimeServiceToken } from '@nocobase/app-server/realtime';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { createCronJobManager, type CronJobManager } from '@nocobase/cron';
import { databaseManagerToken } from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';

import type { NocoProjectConfig } from '../config/nocoproject.js';
import type { AgentService } from '../modules/agent/agent.service.js';
import type {
  AttachmentService,
  FileObjectStore,
} from '../modules/attachment/attachment.service.js';
import {
  createAttachmentTextReader,
  type AttachmentTextReader,
} from '../modules/intake/attachment-text.js';
import type { AgentEnvService } from '../modules/agent/env.service.js';
import type { ReactionService } from '../modules/collaboration/reaction.service.js';
import type { GitConnectionService } from '../modules/git/connection.service.js';
import type { PullRequestMergeService } from '../modules/git/merge.service.js';
import type { PullRequestService } from '../modules/git/pull-request.service.js';
import type { WebhookService } from '../modules/git/webhook.service.js';
import {
  createAiIntakeParser,
  type AiAgentFactory,
} from '../modules/intake/ai-parser.js';
import { createAiProcessClassifier } from '../modules/intake/process-classifier.js';
import type { DesignService } from '../modules/issue/design.service.js';
import type { PmService } from '../modules/pm/pm.service.js';
import type { ChecklistService } from '../modules/workflow/checklist.js';
import type { WorkflowProposalService } from '../modules/workflow/workflow.proposals.js';
import type { IntakeService } from '../modules/intake/intake.service.js';
import type { DeliveryService } from '../modules/issue/delivery.service.js';
import type { KnowledgeService } from '../modules/knowledge/knowledge.service.js';
import type { MetricsService } from '../modules/metrics/metrics.service.js';
import type { ApprovalGateway } from '../modules/shared/approval.js';
import {
  createSecretBox,
  resolveSecretKey,
  type SecretBox,
} from '../modules/shared/crypto.js';
import type { SkillService } from '../modules/skill/skill.service.js';
import type { WorkspaceSettingsService } from '../modules/system/settings.admin.js';
import type { UsageService } from '../modules/usage/usage.service.js';
import type { CommentService } from '../modules/collaboration/comment.service.js';
import type { IssueQueries } from '../modules/issue/issue.queries.js';
import type { IssueService } from '../modules/issue/issue.service.js';
import type { LabelService } from '../modules/label/label.service.js';
import type { MemberService } from '../modules/member/member.service.js';
import type { InboxService } from '../modules/notification/inbox.service.js';
import type { AgentIssueService } from '../modules/subtask/agent-issue.service.js';
import type { DependencyService } from '../modules/subtask/dependency.service.js';
import type { ProposalService } from '../modules/subtask/proposal.service.js';
import type { WorkflowService } from '../modules/workflow/workflow.service.js';
import type { ProjectService } from '../modules/project/project.service.js';
import type { ClaimService } from '../modules/run/claim.service.js';
import type { RunRecoveryService } from '../modules/run/failure.js';
import type { RunEventService } from '../modules/run/run-events.js';
import type { RunQueries } from '../modules/run/run.queries.js';
import type { RunService } from '../modules/run/run.service.js';
import {
  SWEEP_CRON_TIME,
  type SweeperService,
} from '../modules/run/sweeper.js';
import type { RunTokenService } from '../modules/run/token.js';
import type { RuntimeService } from '../modules/runtime/runtime.service.js';
import { createNpServices, type NpServices } from '../modules/services.js';
import type { InvitationService } from '../modules/member/invitation.service.js';
import { createPluginComputerKeys } from './np-computer-keys.js';
import type { ComputerService } from '../modules/computer/computer.service.js';
import type { DaemonWakeups } from '../modules/runtime/daemon-wakeups.js';
import {
  createNotificationMailer,
  createPluginAccounts,
} from './np-invitations.js';
import { createDomainEventBus } from '../modules/shared/events.js';
import {
  connectRealtime,
  type NpRealtimeTopics,
} from '../modules/shared/realtime-bridge.js';
import type { TriggerService } from '../modules/trigger/trigger.service.js';
import {
  createBuiltinRoles,
  reconcileRoleProjection,
  registerNpAuthorization,
} from './np-authorization.js';

export const npServicesToken: ServiceToken<NpServices> =
  createServiceToken<NpServices>('nocoproject/services');
export const npProjectServiceToken: ServiceToken<ProjectService> =
  createServiceToken<ProjectService>('nocoproject/project-service');
export const npIssueServiceToken: ServiceToken<IssueService> =
  createServiceToken<IssueService>('nocoproject/issue-service');
export const npIssueQueriesToken: ServiceToken<IssueQueries> =
  createServiceToken<IssueQueries>('nocoproject/issue-queries');
export const npCommentServiceToken: ServiceToken<CommentService> =
  createServiceToken<CommentService>('nocoproject/comment-service');
export const npAgentServiceToken: ServiceToken<AgentService> =
  createServiceToken<AgentService>('nocoproject/agent-service');
export const npDaemonWakeupsToken: ServiceToken<DaemonWakeups> =
  createServiceToken<DaemonWakeups>('nocoproject/daemon-wakeups');
export const npComputerServiceToken: ServiceToken<ComputerService> =
  createServiceToken<ComputerService>('nocoproject/computer-service');
export const npRuntimeServiceToken: ServiceToken<RuntimeService> =
  createServiceToken<RuntimeService>('nocoproject/runtime-service');
export const npTriggerServiceToken: ServiceToken<TriggerService> =
  createServiceToken<TriggerService>('nocoproject/trigger-service');
export const npRunServiceToken: ServiceToken<RunService> =
  createServiceToken<RunService>('nocoproject/run-service');
export const npRunRecoveryServiceToken: ServiceToken<RunRecoveryService> =
  createServiceToken<RunRecoveryService>('nocoproject/run-recovery-service');
export const npRunEventServiceToken: ServiceToken<RunEventService> =
  createServiceToken<RunEventService>('nocoproject/run-event-service');
export const npRunQueriesToken: ServiceToken<RunQueries> =
  createServiceToken<RunQueries>('nocoproject/run-queries');
export const npClaimServiceToken: ServiceToken<ClaimService> =
  createServiceToken<ClaimService>('nocoproject/claim-service');
export const npRunTokenServiceToken: ServiceToken<RunTokenService> =
  createServiceToken<RunTokenService>('nocoproject/run-token-service');
export const npSweeperServiceToken: ServiceToken<SweeperService> =
  createServiceToken<SweeperService>('nocoproject/sweeper-service');
export const npWorkflowServiceToken: ServiceToken<WorkflowService> =
  createServiceToken<WorkflowService>('nocoproject/workflow-service');
export const npMemberServiceToken: ServiceToken<MemberService> =
  createServiceToken<MemberService>('nocoproject/member-service');
export const npLabelServiceToken: ServiceToken<LabelService> =
  createServiceToken<LabelService>('nocoproject/label-service');
export const npDependencyServiceToken: ServiceToken<DependencyService> =
  createServiceToken<DependencyService>('nocoproject/dependency-service');
export const npProposalServiceToken: ServiceToken<ProposalService> =
  createServiceToken<ProposalService>('nocoproject/proposal-service');
export const npAgentIssueServiceToken: ServiceToken<AgentIssueService> =
  createServiceToken<AgentIssueService>('nocoproject/agent-issue-service');
export const npInboxServiceToken: ServiceToken<InboxService> =
  createServiceToken<InboxService>('nocoproject/inbox-service');
export const npApprovalGatewayToken: ServiceToken<ApprovalGateway> =
  createServiceToken<ApprovalGateway>('nocoproject/approval-gateway');
export const npGitConnectionServiceToken: ServiceToken<GitConnectionService> =
  createServiceToken<GitConnectionService>(
    'nocoproject/git-connection-service',
  );
export const npPullRequestServiceToken: ServiceToken<PullRequestService> =
  createServiceToken<PullRequestService>('nocoproject/pull-request-service');
export const npWebhookServiceToken: ServiceToken<WebhookService> =
  createServiceToken<WebhookService>('nocoproject/webhook-service');
export const npIntakeServiceToken: ServiceToken<IntakeService> =
  createServiceToken<IntakeService>('nocoproject/intake-service');
export const npReactionServiceToken: ServiceToken<ReactionService> =
  createServiceToken<ReactionService>('nocoproject/reaction-service');
export const npAgentEnvServiceToken: ServiceToken<AgentEnvService> =
  createServiceToken<AgentEnvService>('nocoproject/agent-env-service');
export const npSkillServiceToken: ServiceToken<SkillService> =
  createServiceToken<SkillService>('nocoproject/skill-service');
export const npUsageServiceToken: ServiceToken<UsageService> =
  createServiceToken<UsageService>('nocoproject/usage-service');
export const npWorkspaceSettingsServiceToken: ServiceToken<WorkspaceSettingsService> =
  createServiceToken<WorkspaceSettingsService>(
    'nocoproject/workspace-settings-service',
  );

export const npKnowledgeServiceToken: ServiceToken<KnowledgeService> =
  createServiceToken<KnowledgeService>('nocoproject/knowledge-service');
export const npMetricsServiceToken: ServiceToken<MetricsService> =
  createServiceToken<MetricsService>('nocoproject/metrics-service');
export const npDeliveryServiceToken: ServiceToken<DeliveryService> =
  createServiceToken<DeliveryService>('nocoproject/delivery-service');
export const npDesignServiceToken: ServiceToken<DesignService> =
  createServiceToken<DesignService>('nocoproject/design-service');
export const npPmServiceToken: ServiceToken<PmService> =
  createServiceToken<PmService>('nocoproject/pm-service');
export const npPullRequestMergeServiceToken: ServiceToken<PullRequestMergeService> =
  createServiceToken<PullRequestMergeService>(
    'nocoproject/pull-request-merge-service',
  );
export const npChecklistServiceToken: ServiceToken<ChecklistService> =
  createServiceToken<ChecklistService>('nocoproject/checklist-service');
export const npWorkflowProposalServiceToken: ServiceToken<WorkflowProposalService> =
  createServiceToken<WorkflowProposalService>(
    'nocoproject/workflow-proposal-service',
  );
export const npAttachmentServiceToken: ServiceToken<AttachmentService> =
  createServiceToken<AttachmentService>('nocoproject/attachment-service');
export const npInvitationServiceToken: ServiceToken<InvitationService> =
  createServiceToken<InvitationService>('nocoproject/invitation-service');

/** Binds a module token to the member of `NpServices` it exposes. */
function bindModule<K extends keyof NpServices>(
  container: Application['container'],
  token: ServiceToken<NpServices[K]>,
  member: K,
): void {
  container.singleton(
    token,
    (resolver) => resolver.resolve(npServicesToken)[member],
  );
}

export default class NpProvider extends ServiceProvider<Application> {
  public readonly name: string = 'nocoproject/np';

  private cron: CronJobManager | undefined;
  private topics: NpRealtimeTopics | undefined;
  private sweeping = false;
  private releaseAuthorization: (() => void)[] = [];
  private reconciling: Promise<void> = Promise.resolve();

  public override register(): void {
    const { container } = this.app;
    container.singleton(npServicesToken, (resolver) => {
      const ai = this.aiFactory();
      return createNpServices({
        database: resolver.resolve(databaseManagerToken),
        idGenerator: resolver.resolve(idGeneratorToken),
        bus: createDomainEventBus((error) =>
          this.logError(error, 'NocoProject domain event listener failed.'),
        ),
        secrets: this.secretBox(),
        fileObjects: this.fileObjects(),
        attachmentText: this.attachmentText(),
        onFileObjectError: (error) =>
          this.logError(error, 'NocoProject attachment object delete failed.'),
        aiIntake: ai ? createAiIntakeParser(ai) : null,
        aiProcess: ai ? createAiProcessClassifier(ai) : null,
        mailer: () => createNotificationMailer(this.app),
        accounts: () => createPluginAccounts(this.app),
        computerKeys: () => createPluginComputerKeys(this.app),
        roles: () => createBuiltinRoles(resolver.resolve(authorizationToken)),
        aiConfigured: () =>
          (this.app.config.get<AIApplicationConfig>('ai')?.llmServices
            ?.length ?? 0) > 0,
      });
    });
    bindModule(container, npProjectServiceToken, 'projects');
    bindModule(container, npIssueServiceToken, 'issues');
    bindModule(container, npIssueQueriesToken, 'issueQueries');
    bindModule(container, npCommentServiceToken, 'comments');
    bindModule(container, npAgentServiceToken, 'agents');
    bindModule(container, npRuntimeServiceToken, 'runtimes');
    bindModule(container, npComputerServiceToken, 'computers');
    bindModule(container, npDaemonWakeupsToken, 'daemonWakeups');
    bindModule(container, npTriggerServiceToken, 'triggers');
    bindModule(container, npRunServiceToken, 'runs');
    bindModule(container, npRunRecoveryServiceToken, 'runRecovery');
    bindModule(container, npRunEventServiceToken, 'runEvents');
    bindModule(container, npRunQueriesToken, 'runQueries');
    bindModule(container, npClaimServiceToken, 'claims');
    bindModule(container, npRunTokenServiceToken, 'runTokens');
    bindModule(container, npSweeperServiceToken, 'sweeper');
    bindModule(container, npWorkflowServiceToken, 'workflows');
    bindModule(container, npMemberServiceToken, 'members');
    bindModule(container, npLabelServiceToken, 'labels');
    bindModule(container, npDependencyServiceToken, 'dependencies');
    bindModule(container, npProposalServiceToken, 'proposals');
    bindModule(container, npAgentIssueServiceToken, 'agentIssues');
    bindModule(container, npInboxServiceToken, 'inbox');
    bindModule(container, npApprovalGatewayToken, 'approvals');
    bindModule(container, npGitConnectionServiceToken, 'gitConnections');
    bindModule(container, npPullRequestServiceToken, 'pullRequests');
    bindModule(container, npWebhookServiceToken, 'webhooks');
    bindModule(container, npIntakeServiceToken, 'intake');
    bindModule(container, npReactionServiceToken, 'reactions');
    bindModule(container, npAgentEnvServiceToken, 'agentEnv');
    bindModule(container, npSkillServiceToken, 'skills');
    bindModule(container, npUsageServiceToken, 'usage');
    bindModule(container, npWorkspaceSettingsServiceToken, 'workspaceSettings');
    bindModule(container, npKnowledgeServiceToken, 'knowledge');
    bindModule(container, npMetricsServiceToken, 'metrics');
    bindModule(container, npDeliveryServiceToken, 'deliveries');
    bindModule(container, npDesignServiceToken, 'design');
    bindModule(container, npPmServiceToken, 'pm');
    bindModule(container, npPullRequestMergeServiceToken, 'pullRequestMerges');
    bindModule(container, npChecklistServiceToken, 'checklists');
    bindModule(container, npWorkflowProposalServiceToken, 'workflowProposals');
    bindModule(container, npAttachmentServiceToken, 'attachments');
    bindModule(container, npInvitationServiceToken, 'invitations');
  }

  /** NP-78: the AI draft tab's (np.newIssue.tabs.ai) files are read through the Drive manager, on the row's own disk, for the AI parser. */
  private attachmentText(): AttachmentTextReader | null {
    const { container } = this.app;
    if (!container.has(driveManagerToken)) return null;
    return createAttachmentTextReader((disk, key) =>
      container.resolve(driveManagerToken).use(disk).getBytes(key),
    );
  }

  /**
   * NP-78 / NP-111: stored attachment objects are read and deleted through the application's Drive manager, on the
   * row's own disk.
   */
  private fileObjects(): FileObjectStore | undefined {
    const { container } = this.app;
    if (!container.has(driveManagerToken)) return undefined;
    return {
      remove: async (disk, key) => {
        await container.resolve(driveManagerToken).use(disk).delete(key);
      },
      open: async (disk, key) =>
        Readable.toWeb(
          await container.resolve(driveManagerToken).use(disk).getStream(key),
        ) as ReadableStream<Uint8Array>,
    };
  }

  /** The key for stored secrets (see `shared/crypto.ts`); warns once when it is derived from `auth.secret`. */
  private secretBox(): SecretBox {
    const config = this.app.config;
    return createSecretBox(
      resolveSecretKey(
        {
          secretKey: config.get<NocoProjectConfig>('nocoproject')?.secretKey,
          authSecret: config.get<AuthConfig>('auth')?.secret,
        },
        (message) => this.logWarning(message),
      ),
    );
  }

  /**
   * The AI intake parser and (iteration 4) the process classifier as one direct model call on the first enabled LLM
   * service (runtime-extensions.md §"A direct model call"): no conversation, no tool loop. The plugin's agent path
   * with a tool-bound `responseFormat` made DeepSeek answer with guesses, while the plain "reply with JSON"
   * instruction is answered faithfully. Null when the plugin is not registered.
   */
  private aiFactory(): AiAgentFactory | null {
    const { container } = this.app;
    if (!container.has(aiManagerToken)) return null;
    return {
      // A direct call has no conversation, so there is no session to record.
      createSession: async () => '',
      createAgent: async ({ systemPrompt }) => ({
        invoke: async ({ userMessages }) => {
          const ai = container.resolve(aiManagerToken);
          const model = await ai.llmProviderManager.resolveModel();
          const { provider } = await ai.llmProviderManager.getLLMService(model);
          const reply = (await provider.invoke({
            messages: [
              { role: 'system', content: systemPrompt },
              ...userMessages,
            ],
          } as never)) as { content?: unknown } | null;
          return { message: { content: reply?.content } };
        },
      }),
    };
  }

  public override async boot(): Promise<void> {
    const { container } = this.app;
    if (container.has(authorizationToken)) {
      const authz = container.resolve(authorizationToken);
      this.releaseAuthorization.push(
        registerNpAuthorization(authz),
        authz.onGrantsChanged(() => this.reconcileRoles()),
      );
    }
    if (!container.has(realtimeServiceToken)) return;
    this.topics = connectRealtime(
      container.resolve(realtimeServiceToken),
      container.resolve(npServicesToken).bus,
    );
  }

  /** Rewrites the `members.role` projection; passes never overlap and a failure is only logged. */
  private reconcileRoles(): Promise<void> {
    const { container } = this.app;
    this.reconciling = this.reconciling.then(async () => {
      try {
        await reconcileRoleProjection(
          container.resolve(authorizationToken),
          container.resolve(databaseManagerToken).connection(),
        );
      } catch (error) {
        this.logError(error, 'NocoProject role projection failed.');
      }
    });
    return this.reconciling;
  }

  public override async start(): Promise<void> {
    if (this.app.container.has(authorizationToken)) await this.reconcileRoles();
    this.cron = createCronJobManager();
    this.cron.addJob({
      cronTime: SWEEP_CRON_TIME,
      onTick: () => void this.sweep(),
    });
    this.cron.start();
  }

  public override async shutdown(): Promise<void> {
    for (const release of this.releaseAuthorization.splice(0)) release();
    await this.reconciling;
    this.cron?.close();
    this.cron = undefined;
    this.topics?.close();
    this.topics = undefined;
    // Release daemons waiting in a wakeup long poll (NP-150).
    if (this.app.container.has(npServicesToken))
      this.app.container.resolve(npServicesToken).daemonWakeups.close();
  }

  /** The cron tick: resolve the sweeper and run one pass, never overlapping a pass still in progress. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = new Date();
      await this.app.container.resolve(npSweeperServiceToken).sweep(now);
      await this.app.container.resolve(npWebhookServiceToken).purge(now);
      await this.app.container
        .resolve(npAttachmentServiceToken)
        .purgeOrphans(now);
    } catch (error) {
      this.logError(error, 'NocoProject sweeper pass failed.');
    } finally {
      this.sweeping = false;
    }
  }

  private logWarning(message: string): void {
    const { container } = this.app;
    if (container.has(loggingToken)) {
      container.resolve(loggingToken).getLogger('nocoproject').warn(message);
      return;
    }
    console.warn(message);
  }

  private logError(error: unknown, message: string): void {
    const { container } = this.app;
    if (container.has(loggingToken)) {
      container
        .resolve(loggingToken)
        .getLogger('nocoproject')
        .error({ err: error }, message);
      return;
    }
    console.error(message, error);
  }
}
