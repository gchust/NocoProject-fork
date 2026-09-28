import type { ProjectResource } from '../../types.js';

/**
 * Moving a repository up or down (iteration 1 leftover "仓库排序"). Positions are rewritten as the list index after
 * the move, and only the resources whose position changes are returned, each becoming one PATCH.
 */
export function sortResources(
  resources: readonly ProjectResource[],
): ProjectResource[] {
  return [...resources].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}

export function reorderResources(
  resources: readonly ProjectResource[],
  from: number,
  to: number,
): { readonly id: string; readonly position: number }[] {
  const sorted = sortResources(resources);
  if (from < 0 || from >= sorted.length || to < 0 || to >= sorted.length) {
    return [];
  }
  const moved = [...sorted];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  return moved
    .map((resource, index) => ({
      id: resource.id,
      position: index,
      before: resource.position,
    }))
    .filter((change) => change.position !== change.before)
    .map(({ id, position }) => ({ id, position }));
}
