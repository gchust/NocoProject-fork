import { isTerminalStatus } from '../../constants.js';
import type {
  ExecutorProposal,
  StatusCatalogEntry,
  SubtaskSummary,
} from '../../types.js';

export interface StageGroup {
  /** The batch number, or null for sub-issues without a stage. */
  readonly stage: number | null;
  readonly subtasks: readonly SubtaskSummary[];
  readonly done: number;
}

/**
 * Sub-issues grouped by stage (§D batches), lowest stage first and the unstaged ones last; inside a group the
 * server's order is kept. `done` counts the terminal ones, for the "2/3" beside each group.
 */
export function groupSubtasksByStage(
  subtasks: readonly SubtaskSummary[],
  catalog?: readonly StatusCatalogEntry[],
): StageGroup[] {
  const groups = new Map<number | null, SubtaskSummary[]>();
  for (const subtask of subtasks) {
    const stage = subtask.stage ?? null;
    groups.set(stage, [...(groups.get(stage) ?? []), subtask]);
  }
  return [...groups]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    })
    .map(([stage, items]) => ({
      stage,
      subtasks: items,
      done: items.filter((item) => isTerminalStatus(item.statusKey, catalog))
        .length,
    }));
}

/** Proposals still waiting for the owner's decision, oldest first. */
export function pendingProposals(
  proposals: readonly ExecutorProposal[],
): ExecutorProposal[] {
  return proposals
    .filter((proposal) => proposal.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
