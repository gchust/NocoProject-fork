/**
 * The iteration 2 modules (git, approval, intake, reactions, env, skills, usage, workspace settings) and the iteration
 * 3 modules (knowledge, acceptance metrics, delivery decisions). Wired by `createNpServices` (`services.ts`); moved
 * out of that file unchanged to keep it under the file length limit.
 */
import { createAgentEnvService } from './agent/env.service.js';
import { createDbApprovalGateway } from './approval/approval.gateway.js';
import { createReactionService } from './collaboration/reaction.service.js';
import { createGitConnectionService } from './git/connection.service.js';
import type { GitHubClient } from './git/github-client.js';
import { createPullRequestService } from './git/pull-request.service.js';
import { createWebhookService } from './git/webhook.service.js';
import { createHeuristicIntakeParser } from './intake/heuristic-parser.js';
import { createIntakeService } from './intake/intake.service.js';
import { createDeliveryService } from './issue/delivery.service.js';
import { createKnowledgeService } from './knowledge/knowledge.service.js';
import { createMetricsService } from './metrics/metrics.service.js';
import type { NpServiceDeps, NpServices } from './services.js';
import { buildProcessClassifier } from './services.iter4.js';
import type { createActivityRecorder } from './shared/activity.js';
import type { ApprovalHooks } from './shared/approval.js';
import type { SecretBox } from './shared/crypto.js';
import type { TxRunner } from './shared/db.js';
import type { createIdSource } from './shared/ids.js';
import type { createUserDirectory } from './shared/users.js';
import { createSkillService } from './skill/skill.service.js';
import { createWorkspaceSettingsService } from './system/settings.admin.js';
import type { SettingsService } from './system/settings.service.js';
import { createUsageService } from './usage/usage.service.js';
import type { WorkflowService } from './workflow/workflow.service.js';

export interface Iteration2Inputs {
  readonly deps: NpServiceDeps;
  readonly tx: TxRunner;
  readonly ids: ReturnType<typeof createIdSource>;
  readonly users: ReturnType<typeof createUserDirectory>;
  readonly activity: ReturnType<typeof createActivityRecorder>;
  readonly settings: SettingsService;
  readonly workflows: WorkflowService;
  readonly secrets: SecretBox;
  readonly github: GitHubClient;
}

/** The iteration 2 modules (git, approval, intake, reactions, env, skills, usage, workspace settings). */
export function createIteration2Services(
  input: Iteration2Inputs,
  services: NpServices,
  hooks: () => ApprovalHooks,
) {
  const {
    deps,
    tx,
    ids,
    users,
    activity,
    settings,
    workflows,
    secrets,
    github,
  } = input;
  const flow = {
    activity,
    settings,
    workflows,
    issues: () => services.issues,
    triggers: () => services.triggers,
  };
  return {
    approvals: deps.approvalGateway
      ? deps.approvalGateway({ tx, hooks })
      : createDbApprovalGateway({ tx, ids, users, activity, hooks }),
    gitConnections: createGitConnectionService({ tx, ids, secrets, github }),
    pullRequests: createPullRequestService({
      ...flow,
      tx,
      ids,
      users,
      secrets,
      github,
    }),
    webhooks: createWebhookService({ ...flow, tx, ids, secrets, github }),
    intake: createIntakeService({
      tx,
      ids,
      users,
      activity,
      settings,
      workflows,
      issues: () => services.issues,
      triggers: () => services.triggers,
      heuristic: createHeuristicIntakeParser(),
      ai: deps.aiIntake ?? null,
      aiConfigured: deps.aiConfigured ?? (() => false),
      classifier: buildProcessClassifier(null, undefined),
      attachmentText: deps.attachmentText ?? null,
    }),
    reactions: createReactionService({ tx, ids, activity }),
    agentEnv: createAgentEnvService({ tx, ids, users, secrets }),
    skills: createSkillService({ tx, ids, users }),
    usage: createUsageService({ tx, settings, users }),
    workspaceSettings: createWorkspaceSettingsService({
      tx,
      settings,
      workflows,
    }),
  };
}

/** The iteration 3 modules (knowledge, acceptance metrics, delivery decisions). */
export function createIteration3Services(
  input: Omit<Iteration2Inputs, 'deps' | 'secrets' | 'github'> & {
    readonly roles: NpServiceDeps['roles'];
  },
  services: NpServices,
) {
  const { tx, ids, users, activity, settings, workflows, roles } = input;
  return {
    knowledge: createKnowledgeService({ tx, ids, users, activity, roles }),
    metrics: createMetricsService({
      tx,
      settings,
      workflows,
      usage: () => services.usage,
    }),
    deliveries: createDeliveryService({
      tx,
      activity,
      workflows,
      issues: () => services.issues,
      comments: () => services.comments,
    }),
  };
}
