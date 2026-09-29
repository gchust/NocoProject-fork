import {
  type CollisionDetection,
  closestCorners,
  pointerWithin,
} from '@dnd-kit/core';
import { issueProcess } from '../../api-iter4.js';
import { needsStartConfirmation } from '../../start-confirmation.js';
import { DESIGN_STATUS_KEYS } from '../../types-iter4.js';
import type {
  BoardGroup,
  IssueListItem,
  StatusCatalogEntry,
  UpdateIssueInput,
} from '../../types.js';

export interface BoardColumn {
  readonly statusKey: string;
  readonly issues: readonly IssueListItem[];
}

/**
 * The board's columns: one per status of the workflow, in its order, each holding the issues in that status. Moves
 * still waiting for the server (`overrides`, issue id → target status) are shown in their target column so a card
 * does not jump back while its PATCH is in flight. An issue in a status the catalog does not know gets a trailing
 * column rather than disappearing. The design-first columns (Analysis, Proposal review; iteration 4 §B) show only while one of
 * them holds an issue or a visible issue follows the design-first process (`withoutIdleDesignColumns`).
 */
export function buildBoardColumns(
  catalog: readonly StatusCatalogEntry[],
  groups: readonly BoardGroup[],
  overrides: ReadonlyMap<string, string> = new Map(),
): BoardColumn[] {
  const columns = new Map<string, IssueListItem[]>(
    catalog.map((entry) => [entry.key, []]),
  );
  for (const group of groups) {
    for (const issue of group.issues) {
      const statusKey =
        overrides.get(issue.id) ?? issue.statusKey ?? group.statusKey;
      const moved =
        statusKey === issue.statusKey ? issue : { ...issue, statusKey };
      columns.set(statusKey, [...(columns.get(statusKey) ?? []), moved]);
    }
  }
  return withoutIdleDesignColumns(
    [...columns].map(([statusKey, issues]) => ({ statusKey, issues })),
  );
}

/** Drops the empty design-first columns when no visible issue is design-first (iteration 4 §B). */
export function withoutIdleDesignColumns(
  columns: readonly BoardColumn[],
): BoardColumn[] {
  const designFirst = columns.some((column) =>
    column.issues.some((issue) => issueProcess(issue) === 'design_first'),
  );
  if (designFirst) return [...columns];
  return columns.filter(
    (column) =>
      !DESIGN_STATUS_KEYS.has(column.statusKey) || column.issues.length > 0,
  );
}

export type BoardMovePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'patch'; readonly changes: UpdateIssueInput }
  | {
      readonly kind: 'confirm';
      readonly changes: UpdateIssueInput;
      readonly agentName: string;
    };

/**
 * What dropping `issue` on the `toStatusKey` column does: nothing (same column), a plain status PATCH, or a PATCH
 * that first asks "start now?" because the move takes an agent-executed issue out of backlog (§J 1).
 */
export function planBoardMove(
  issue: IssueListItem,
  toStatusKey: string,
  catalog: readonly StatusCatalogEntry[],
): BoardMovePlan {
  if (!toStatusKey || toStatusKey === issue.statusKey) return { kind: 'none' };
  const changes: UpdateIssueInput = { statusKey: toStatusKey };
  const confirm = needsStartConfirmation({
    fromStatusKey: issue.statusKey,
    toStatusKey,
    executorBefore: { type: issue.executorType, id: issue.executorId },
    catalog,
  });
  return confirm
    ? {
        kind: 'confirm',
        changes,
        agentName: issue.executorName ?? issue.executorId ?? '',
      }
    : { kind: 'patch', changes };
}

/**
 * Where a drop lands. The column under the pointer wins, so a card can be dropped into an empty column: with
 * `closestCorners` alone a tall empty column loses to the nearest card of the column the drag started in.
 */
export const boardCollisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCorners(args);
};

/**
 * The column a drag ended over. dnd-kit reports either a column (its droppable id is `column:<statusKey>`) or a
 * card inside one (its sortable id is the issue id), so a card is resolved to the column it sits in.
 */
export function resolveDropStatus(
  overId: string | null | undefined,
  columns: readonly BoardColumn[],
): string | null {
  if (!overId) return null;
  if (overId.startsWith('column:')) return overId.slice('column:'.length);
  return (
    columns.find((column) => column.issues.some((issue) => issue.id === overId))
      ?.statusKey ?? null
  );
}

/** The error codes that mean "this move is not allowed" rather than a failed request (§J 1). */
export function isRejectedTransition(
  status: number | undefined,
  code: string | undefined,
): boolean {
  return (
    (status === 403 && code === 'TRANSITION_NOT_ALLOWED') ||
    status === 409 ||
    (status === 400 && code === 'TRANSITION_NOT_ALLOWED')
  );
}
