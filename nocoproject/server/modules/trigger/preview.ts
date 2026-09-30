/**
 * NP-183 (protocol-pm-assistant.md §3.4): which runs an operation starts, known by performing it. Inside
 * `collectRuns(fn)` every enqueue attempt the trigger rules make (`enqueueFor`) is recorded, whether it started a run
 * or was skipped because the invoking member may not invoke the agent. The project manager's direct writes and plan
 * checks run the real operation this way and roll back: the rules stay in one place and the answer is exact. Domain
 * events are emitted only after the outermost commit, so a rolled back rehearsal notifies nobody and wakes no daemon.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RunAttempt {
  readonly agentId: string;
  readonly issueId: string;
  readonly triggerType: string;
  /** false: the trigger rules skipped it (no invocation right, or the issue is blocked). */
  readonly started: boolean;
}

const recording = new AsyncLocalStorage<RunAttempt[]>();

/** Runs `fn`, returning what it produced and every run attempt the trigger rules made meanwhile. */
export async function collectRuns<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; runs: RunAttempt[] }> {
  const runs: RunAttempt[] = [];
  const value = await recording.run(runs, fn);
  return { value, runs };
}

/** Called by `enqueueFor` for every attempt. */
export function recordRunAttempt(attempt: RunAttempt): void {
  recording.getStore()?.push(attempt);
}
