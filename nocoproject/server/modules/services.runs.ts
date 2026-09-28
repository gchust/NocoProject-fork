/**
 * The run modules of `createNpServices` (`services.ts`): lifecycle, recovery and retries, events, queries, claims,
 * run tokens and the sweeper. Split out in iteration 4 to keep `createNpServices` within the function size limit;
 * the wiring is unchanged (the run service gained the activity recorder for `retrospective_done`).
 */
import type { SecretBox } from './shared/crypto.js';
import type { ActivityRecorder } from './shared/activity.js';
import type { TxRunner } from './shared/db.js';
import type { IdSource } from './shared/ids.js';
import type { UserDirectory } from './shared/users.js';
import type { WorkflowService } from './workflow/workflow.service.js';
import { createClaimService } from './run/claim.service.js';
import { createRunRecoveryService, type FailureDeps } from './run/failure.js';
import { createRunEventService } from './run/run-events.js';
import { createRunQueries } from './run/run.queries.js';
import { createRunService } from './run/run.service.js';
import { createSweeperService } from './run/sweeper.js';
import { createRunTokenService } from './run/token.js';
import type { NpServices } from './services.js';

export interface RunModuleInputs {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly workflows: WorkflowService;
  readonly secrets: SecretBox;
}

export function createRunModules(
  input: RunModuleInputs,
  services: NpServices,
): Pick<
  NpServices,
  | 'runs'
  | 'runRecovery'
  | 'runEvents'
  | 'runQueries'
  | 'claims'
  | 'runTokens'
  | 'sweeper'
> {
  const { tx, ids, users, activity, workflows, secrets } = input;
  const failureDeps: FailureDeps = {
    tx,
    ids,
    collaborators: () => ({
      scheduleRetry: (unit, failed, maxAttempts, reason) =>
        services.triggers.retryFailedRun(unit, failed, maxAttempts, reason),
      resetAbandonedIssue: (unit, issueId) =>
        services.issues.resetAbandonedIssue(unit, issueId),
    }),
  };
  return {
    runs: createRunService({ tx, ids, activity }),
    runRecovery: createRunRecoveryService({
      ...failureDeps,
      manualRetry: (unit, run, actor) =>
        services.triggers.manualRetry(unit, run, actor),
    }),
    runEvents: createRunEventService({ tx, ids }),
    runQueries: createRunQueries({ tx }),
    claims: createClaimService({
      tx,
      ids,
      users,
      workflows,
      secrets,
      knowledge: () => services.knowledge,
    }),
    runTokens: createRunTokenService({ tx }),
    sweeper: createSweeperService(failureDeps),
  };
}
