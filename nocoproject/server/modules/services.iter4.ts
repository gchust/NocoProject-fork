/**
 * The iteration 4 modules (docs/phase1/iteration-4-contract.md): the process classifier (heuristic, plus the AI
 * classifier when the provider hands one in), the design proposals and decisions, and the project manager
 * (conversation and the manager's reads). Wired by `createNpServices` (`services.ts`).
 */
import type { ActivityRecorder } from './shared/activity.js';
import type { SecretBox } from './shared/crypto.js';
import type { TxRunner } from './shared/db.js';
import type { IdSource } from './shared/ids.js';
import type { UserDirectory } from './shared/users.js';
import type { SettingsService } from './system/settings.service.js';
import type { WorkflowService } from './workflow/workflow.service.js';
import {
  createDesignService,
  type DesignService,
} from './issue/design.service.js';
import {
  createProcessClassifier,
  type AiProcessClassifier,
  type ProcessClassifier,
} from './intake/process-classifier.js';
import type { GitHubClient } from './git/github-client.js';
import {
  createPullRequestMergeService,
  type PullRequestMergeService,
} from './git/merge.service.js';
import { createPmService, type PmService } from './pm/pm.service.js';
import type { NpServices } from './services.js';

export interface Iteration4Services {
  readonly design: DesignService;
  readonly pm: PmService;
  /** NP-85: merging linked pull requests from NocoProject. */
  readonly pullRequestMerges: PullRequestMergeService;
}

export interface Iteration4Inputs {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly secrets: SecretBox;
  readonly github: GitHubClient;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly settings: SettingsService;
  readonly workflows: WorkflowService;
}

/** The classifier `IssueService.create` uses for `process: auto`. */
export function buildProcessClassifier(
  ai: AiProcessClassifier | null | undefined,
  aiConfigured: (() => boolean) | undefined,
): ProcessClassifier {
  return createProcessClassifier({
    ai: ai ?? null,
    aiConfigured: aiConfigured ?? (() => false),
  });
}

export function createIteration4Services(
  input: Iteration4Inputs,
  services: NpServices,
): Iteration4Services {
  const { tx, ids, secrets, github, users, activity, settings, workflows } =
    input;
  return {
    pullRequestMerges: createPullRequestMergeService({
      tx,
      ids,
      activity,
      secrets,
      github,
      settings,
      workflows,
      issues: () => services.issues,
    }),
    design: createDesignService({
      tx,
      activity,
      workflows,
      issues: () => services.issues,
      comments: () => services.comments,
      triggers: () => services.triggers,
    }),
    pm: createPmService({
      tx,
      users,
      activity,
      settings,
      issues: () => services.issues,
      queries: () => services.issueQueries,
      projects: () => services.projects,
      inbox: () => services.inbox,
      metrics: () => services.metrics,
      knowledge: () => services.knowledge,
    }),
  };
}
