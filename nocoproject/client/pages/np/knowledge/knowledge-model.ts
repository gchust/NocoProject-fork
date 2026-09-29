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

/** `/knowledge`'s content: the tree (default) or the existing table; a search always shows the table (§B). */
export type KnowledgeView = 'tree' | 'list';

const KNOWLEDGE_VIEW_STORAGE_KEY = 'nocoproject:knowledge-view';

/** `?view=` when the URL names one, else the person's last choice, else the tree. */
export function resolveKnowledgeView(params: URLSearchParams): KnowledgeView {
  const value = params.get('view');
  if (value === 'tree' || value === 'list') return value;
  return readStoredKnowledgeView() ?? 'tree';
}

export function readStoredKnowledgeView(): KnowledgeView | null {
  try {
    const value = window.localStorage.getItem(KNOWLEDGE_VIEW_STORAGE_KEY);
    return value === 'tree' || value === 'list' ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the view; a private window or blocked storage just forgets it. */
export function storeKnowledgeView(view: KnowledgeView): void {
  try {
    window.localStorage.setItem(KNOWLEDGE_VIEW_STORAGE_KEY, view);
  } catch {
    // The choice is a convenience; the URL still carries it for this visit.
  }
}

/** A document tree node (NP-147): the document plus its direct children, already sorted. */
export interface KnowledgeTreeNode {
  readonly doc: KnowledgeDocSummary;
  readonly children: readonly KnowledgeTreeNode[];
}

/**
 * Builds the forest of `docs` from `parentId`/`sortOrder`. A document whose declared parent is missing from `docs`
 * (out of the current scope, or archived and filtered out) surfaces as a root rather than disappearing, so the tree
 * never silently drops a document.
 */
export function buildKnowledgeTree(
  docs: readonly KnowledgeDocSummary[],
): KnowledgeTreeNode[] {
  const ids = new Set(docs.map((doc) => doc.id));
  const byParent = new Map<string | null, KnowledgeDocSummary[]>();
  for (const doc of docs) {
    const parentId =
      doc.parentId && ids.has(doc.parentId) ? doc.parentId : null;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(doc);
    else byParent.set(parentId, [doc]);
  }
  const childrenOf = (parentId: string | null): KnowledgeTreeNode[] =>
    [...(byParent.get(parentId) ?? [])]
      .sort(
        (a, b) =>
          (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
          a.title.localeCompare(b.title),
      )
      .map((doc) => ({ doc, children: childrenOf(doc.id) }));
  return childrenOf(null);
}

/** The ids of `docId` and every descendant, in `docs` — the documents that cannot become its own new parent. */
export function knowledgeSubtreeIds(
  docs: readonly KnowledgeDocSummary[],
  docId: string,
): Set<string> {
  const byParent = new Map<string | null, string[]>();
  for (const doc of docs) {
    const parentId = doc.parentId ?? null;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(doc.id);
    else byParent.set(parentId, [doc.id]);
  }
  const subtree = new Set<string>([docId]);
  const stack = [docId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const childId of byParent.get(current) ?? []) {
      if (!subtree.has(childId)) {
        subtree.add(childId);
        stack.push(childId);
      }
    }
  }
  return subtree;
}

/** The direct, non-archived-first children of `parentId` in `docs`, sorted like `buildKnowledgeTree`. */
export function knowledgeChildren(
  docs: readonly KnowledgeDocSummary[],
  parentId: string,
): KnowledgeDocSummary[] {
  return docs
    .filter((doc) => doc.parentId === parentId)
    .sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
        a.title.localeCompare(b.title),
    );
}

/** The `sortOrder` for a new last child of `parentId` among `docs`. */
export function nextKnowledgeSortOrder(
  docs: readonly KnowledgeDocSummary[],
  parentId: string | null,
): number {
  return (
    docs
      .filter((doc) => (doc.parentId ?? null) === parentId)
      .reduce((max, doc) => Math.max(max, doc.sortOrder ?? 0), -1) + 1
  );
}
