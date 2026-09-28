import { statusCategory } from '../constants.js';
import type {
  BoardGroup,
  ProjectIssueCounts,
  ProjectStatus,
  StatusCatalogEntry,
} from '../types.js';

export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'planned',
  'in_progress',
  'paused',
  'completed',
  'cancelled',
];

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return PROJECT_STATUSES.includes(value as ProjectStatus);
}

/** `np.projectStatus.*` keys drop the underscore like the issue statuses do (`in_progress` → `inProgress`). */
export function projectStatusKey(status: ProjectStatus): string {
  return `np.projectStatus.${status.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase())}`;
}

export interface ProjectProgress {
  readonly done: number;
  readonly total: number;
  /** 0–100, rounded down so a nearly finished project does not read as complete. */
  readonly percent: number;
}

function progressOf(done: number, total: number): ProjectProgress {
  const safeTotal = Math.max(0, total);
  const safeDone = Math.min(Math.max(0, done), safeTotal);
  return {
    done: safeDone,
    total: safeTotal,
    percent: safeTotal === 0 ? 0 : Math.floor((safeDone / safeTotal) * 100),
  };
}

/**
 * Progress from the list endpoint's `issueCounts` (§F). `done` counts issues in a done-category status; cancelled
 * issues stay in the total, as the server counts them.
 */
export function progressFromCounts(
  counts: ProjectIssueCounts | undefined,
): ProjectProgress {
  return progressOf(counts?.done ?? 0, counts?.total ?? 0);
}

/**
 * Progress from the project's board groups, for the detail page, which has the issues but no counts. Closed
 * (cancelled) issues are left out of both sides: they are not work that remains, nor work that was delivered.
 */
export function progressFromGroups(
  groups: readonly BoardGroup[],
  catalog: readonly StatusCatalogEntry[],
): ProjectProgress {
  let done = 0;
  let total = 0;
  for (const group of groups) {
    for (const issue of group.issues) {
      const category = statusCategory(
        issue.statusKey ?? group.statusKey,
        catalog,
      );
      if (category === 'closed') continue;
      total += 1;
      if (category === 'done') done += 1;
    }
  }
  return progressOf(done, total);
}

export interface ProjectNumbers {
  readonly total: number;
  readonly started: number;
  readonly review: number;
  readonly done: number;
}

/** The key numbers of a project from its per-status counts (the detail's `issueCounts.byStatus`). */
export function projectNumbers(
  byStatus: Readonly<Record<string, number>>,
  catalog: readonly StatusCatalogEntry[],
): ProjectNumbers {
  let total = 0;
  let started = 0;
  let review = 0;
  let done = 0;
  for (const [key, count] of Object.entries(byStatus)) {
    total += count;
    const category = statusCategory(key, catalog);
    if (key === 'in_review') review += count;
    else if (category === 'started') started += count;
    if (category === 'done') done += count;
  }
  return { total, started, review, done };
}
