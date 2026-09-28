import { isWorkspaceAdmin, type Viewer } from '../permissions.js';
import type { ProjectListItem } from '../types.js';
import type { KnowledgeDocSummary } from '../types-iter3.js';

/**
 * Knowledge base rules as the browser applies them (§B): project documents are written by the project lead and
 * owner/admin, workspace documents by owner/admin only; the server enforces the same and says so with `canEdit` when
 * it sends it.
 */
export function canEditKnowledge(
  doc: Pick<KnowledgeDocSummary, 'projectId' | 'canEdit'>,
  viewer: Viewer | null,
  projects: readonly ProjectListItem[] | undefined,
): boolean {
  if (typeof doc.canEdit === 'boolean') return doc.canEdit;
  return canWriteIn(doc.projectId, viewer, projects);
}

/** Whether the viewer may create or edit documents in `projectId` (null = the workspace). */
export function canWriteIn(
  projectId: string | null,
  viewer: Viewer | null,
  projects: readonly ProjectListItem[] | undefined,
): boolean {
  if (!viewer) return false;
  if (isWorkspaceAdmin(viewer)) return true;
  if (!projectId) return false;
  const project = projects?.find((candidate) => candidate.id === projectId);
  return !!project?.leadUserId && project.leadUserId === viewer.userId;
}

/** The projects the viewer may write into, for the create dialog's project select. */
export function writableProjects(
  viewer: Viewer | null,
  projects: readonly ProjectListItem[] | undefined,
): ProjectListItem[] {
  return (projects ?? []).filter((project) =>
    canWriteIn(project.id, viewer, projects),
  );
}

/** `?project=` of the list: a project id, `workspace` for workspace documents only, or nothing for everything. */
export type KnowledgeScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'project'; readonly projectId: string };

export function readKnowledgeScope(value: string | null): KnowledgeScope {
  if (!value) return { kind: 'all' };
  if (value === 'workspace') return { kind: 'workspace' };
  return { kind: 'project', projectId: value };
}

/**
 * The server filters by project; "workspace only" has no query of its own, so it asks for everything and keeps the
 * documents without a project. Archived documents are listed last.
 */
export function filterKnowledge(
  docs: readonly KnowledgeDocSummary[],
  scope: KnowledgeScope,
): KnowledgeDocSummary[] {
  return docs
    .filter((doc) => scope.kind !== 'workspace' || !doc.projectId)
    .sort(
      (a, b) =>
        Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}
