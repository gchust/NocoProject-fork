/**
 * Row mapping and lookups for the knowledge tables (docs/phase1/iteration-3-contract.md §A, §B).
 *
 * System-level documents store `projectId = ''` (so unique(projectId, slug) covers them); the API reports null.
 * Proposals store a real null. Documents whose project no longer exists are treated as gone.
 */
import type { Conn } from '../shared/db.js';
import { iso, isoOrNull, num, str, unique } from '../shared/db.js';
import { conflict, invalid } from '../shared/errors.js';
import type {
  KnowledgeAuthorType,
  KnowledgeDoc,
  KnowledgeDocSummary,
  KnowledgeDocVersion,
  KnowledgeProposal,
  KnowledgeProposalStatus,
  KnowledgeVersionAuthorType,
} from '../shared/protocol.js';
import {
  KNOWLEDGE_CONTENT_MAX,
  KNOWLEDGE_SLUG_PATTERN,
  KNOWLEDGE_SUMMARY_MAX,
  KNOWLEDGE_TITLE_MAX,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { agentNames } from '../run/run.queries.js';

export const SYSTEM_PROJECT_KEY = '';
const MAX_SLUG_LENGTH = 64;

/** The stored `knowledgeDocs.projectId` for a project id (null = system-level). */
export function projectKey(projectId: string | null): string {
  return projectId ?? SYSTEM_PROJECT_KEY;
}

export function projectIdOf(value: unknown): string | null {
  const id = str(value);
  return id ? id : null;
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/u, '');
  return slug || 'doc';
}

export function validateTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > KNOWLEDGE_TITLE_MAX)
    throw invalid(
      'INVALID_TITLE',
      `title is required (at most ${KNOWLEDGE_TITLE_MAX} characters).`,
    );
  return title;
}

export function validateSlug(value: unknown): string {
  if (typeof value !== 'string' || !KNOWLEDGE_SLUG_PATTERN.test(value))
    throw invalid(
      'INVALID_SLUG',
      'slug must be 1–64 lowercase letters, digits or hyphens, not starting with a hyphen.',
    );
  return value;
}

export function validateSummary(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > KNOWLEDGE_SUMMARY_MAX)
    throw invalid(
      'INVALID_SUMMARY',
      `summary must be text of at most ${KNOWLEDGE_SUMMARY_MAX} characters.`,
    );
  return value.trim();
}

export function validateContent(value: unknown): string {
  if (typeof value !== 'string' || value.length > KNOWLEDGE_CONTENT_MAX)
    throw invalid(
      'INVALID_CONTENT',
      `content must be Markdown text of at most ${KNOWLEDGE_CONTENT_MAX} characters.`,
    );
  return value;
}

export async function findDocRow(
  conn: Conn,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  return conn.query
    .selectFrom('knowledgeDocs')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function findDocRowBySlug(
  conn: Conn,
  key: string,
  slug: string,
): Promise<Record<string, unknown> | undefined> {
  return conn.query
    .selectFrom('knowledgeDocs')
    .selectAll()
    .where('projectId', '=', key)
    .where('slug', '=', slug)
    .executeTakeFirst();
}

/** `base`, or `base-2`, `base-3`… — the first slug free in the scope. */
export async function uniqueSlug(
  conn: Conn,
  key: string,
  base: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const slug = `${base.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
    if (!(await findDocRowBySlug(conn, key, slug))) return slug;
  }
  throw conflict(
    'KNOWLEDGE_SLUG_TAKEN',
    'Could not derive a unique slug from this title.',
  );
}

/** Existing projects' names by id (documents of a deleted project are left out by the callers). */
export async function projectNames(
  conn: Conn,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = unique(ids);
  if (wanted.length === 0) return new Map();
  const rows = await conn.query
    .selectFrom('projects')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .execute();
  return new Map(rows.map((row) => [str(row.id) ?? '', str(row.name) ?? '']));
}

/** Display names of user and agent actors, keyed `user:<id>` / `agent:<id>`. */
export async function actorNames(
  conn: Conn,
  users: UserDirectory,
  actors: readonly { type: string | null; id: string | null }[],
): Promise<Map<string, string>> {
  const userNames = await users.names(
    conn,
    actors.filter((actor) => actor.type === 'user').map((actor) => actor.id),
  );
  const agents = await agentNames(
    conn,
    actors.filter((actor) => actor.type === 'agent').map((actor) => actor.id),
  );
  const result = new Map<string, string>();
  for (const [id, name] of userNames) result.set(`user:${id}`, name);
  for (const [id, name] of agents) result.set(`agent:${id}`, name);
  return result;
}

async function pendingCounts(
  conn: Conn,
  docIds: readonly string[],
): Promise<Map<string, number>> {
  if (docIds.length === 0) return new Map();
  const rows = await conn.query
    .selectFrom('knowledgeProposals')
    .select((eb) => ['docId', eb.fn.countAll().as('count')])
    .where('docId', 'in', unique(docIds))
    .where('status', '=', 'pending')
    .groupBy('docId')
    .execute();
  return new Map(rows.map((row) => [str(row.docId) ?? '', num(row.count)]));
}

/** Direct, non-archived child counts of the given documents (NP-147). */
export async function childCounts(
  conn: Conn,
  docIds: readonly string[],
): Promise<Map<string, number>> {
  if (docIds.length === 0) return new Map();
  const rows = await conn.query
    .selectFrom('knowledgeDocs')
    .select((eb) => ['parentId', eb.fn.countAll().as('count')])
    .where('parentId', 'in', unique(docIds))
    .where('archivedAt', 'is', null)
    .groupBy('parentId')
    .execute();
  return new Map(rows.map((row) => [str(row.parentId) ?? '', num(row.count)]));
}

/** The next sibling position: the count of existing documents in the same scope under the same parent. */
export async function nextSortOrder(
  conn: Conn,
  key: string,
  parentId: string | null,
): Promise<number> {
  let select = conn.query
    .selectFrom('knowledgeDocs')
    .select((eb) => [eb.fn.countAll().as('count')])
    .where('projectId', '=', key);
  select =
    parentId === null
      ? select.where('parentId', 'is', null)
      : select.where('parentId', '=', parentId);
  const row = await select.executeTakeFirst();
  return num(row?.count);
}

const MAX_DEPTH_WALK = 100;

/** The document's depth (1 = root), walking `parentId` to the root; a cycle stops the walk rather than looping. */
export async function depthOf(conn: Conn, id: string): Promise<number> {
  let depth = 1;
  const seen = new Set<string>([id]);
  let current = await findDocRow(conn, id);
  for (let steps = 0; steps < MAX_DEPTH_WALK; steps += 1) {
    const parentId = current ? str(current.parentId) : null;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    depth += 1;
    current = await findDocRow(conn, parentId);
  }
  return depth;
}

/** The tallest chain of descendants under `id`, counting `id` itself as 1 (a leaf has height 1). */
export async function subtreeHeight(conn: Conn, id: string): Promise<number> {
  const children = await conn.query
    .selectFrom('knowledgeDocs')
    .select('id')
    .where('parentId', '=', id)
    .execute();
  if (children.length === 0) return 1;
  let max = 1;
  for (const child of children) {
    const height = await subtreeHeight(conn, str(child.id) ?? '');
    if (height + 1 > max) max = height + 1;
  }
  return max;
}

/** Whether `candidateParentId` is `docId` itself or one of its descendants (an invalid move target). */
export async function isSelfOrDescendant(
  conn: Conn,
  candidateParentId: string,
  docId: string,
): Promise<boolean> {
  if (candidateParentId === docId) return true;
  const seen = new Set<string>([candidateParentId]);
  let current = await findDocRow(conn, candidateParentId);
  for (let steps = 0; steps < MAX_DEPTH_WALK; steps += 1) {
    const parentId = current ? str(current.parentId) : null;
    if (!parentId) return false;
    if (parentId === docId) return true;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    current = await findDocRow(conn, parentId);
  }
  return false;
}

/** Ancestors of `id` from the root to its immediate parent, in the same scope, root first. */
export async function breadcrumbsOf(
  conn: Conn,
  id: string,
): Promise<{ id: string; title: string; slug: string }[]> {
  const chain: { id: string; title: string; slug: string }[] = [];
  const seen = new Set<string>([id]);
  const self = await findDocRow(conn, id);
  let parentId = self ? str(self.parentId) : null;
  for (let steps = 0; steps < MAX_DEPTH_WALK && parentId; steps += 1) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = await findDocRow(conn, parentId);
    if (!parent) break;
    chain.unshift({
      id: parentId,
      title: str(parent.title) ?? '',
      slug: str(parent.slug) ?? '',
    });
    parentId = str(parent.parentId);
  }
  return chain;
}

export interface DocDecoration {
  readonly users: UserDirectory;
  /** Whether the viewer may edit a document of this scope (null = system). */
  readonly canEdit: (projectId: string | null) => boolean;
}

/** Summaries for document rows; documents of a project that no longer exists are dropped. */
export async function decorateDocs(
  conn: Conn,
  decoration: DocDecoration,
  rows: readonly Record<string, unknown>[],
): Promise<KnowledgeDoc[]> {
  const projects = await projectNames(
    conn,
    rows.map((row) => projectIdOf(row.projectId)),
  );
  const live = rows.filter((row) => {
    const projectId = projectIdOf(row.projectId);
    return projectId === null || projects.has(projectId);
  });
  const names = await actorNames(
    conn,
    decoration.users,
    live.map((row) => ({
      type: str(row.updatedByType),
      id: str(row.updatedById),
    })),
  );
  const pending = await pendingCounts(
    conn,
    live.map((row) => str(row.id) ?? ''),
  );
  const children = await childCounts(
    conn,
    live.map((row) => str(row.id) ?? ''),
  );
  return live.map((row) => {
    const id = str(row.id) ?? '';
    const projectId = projectIdOf(row.projectId);
    const updatedByType: KnowledgeAuthorType =
      row.updatedByType === 'agent' ? 'agent' : 'user';
    const updatedById = str(row.updatedById);
    return {
      id,
      projectId,
      projectName: projectId ? (projects.get(projectId) ?? null) : null,
      title: str(row.title) ?? '',
      slug: str(row.slug) ?? '',
      summary: str(row.summary) ?? '',
      content: str(row.content) ?? '',
      parentId: str(row.parentId),
      sortOrder: num(row.sortOrder),
      childCount: children.get(id) ?? 0,
      version: num(row.version, 1),
      updatedByType,
      updatedById,
      updatedByName: names.get(`${updatedByType}:${updatedById}`) ?? null,
      archivedAt: isoOrNull(row.archivedAt),
      pendingProposalCount: pending.get(id) ?? 0,
      canEdit: decoration.canEdit(projectId),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  });
}

export function toSummary(doc: KnowledgeDoc): KnowledgeDocSummary {
  const { content: _content, ...summary } = doc;
  return summary;
}

const EXCERPT_RADIUS = 60;

/** Whether `needle` (already lower-cased) appears in the title, slug, summary or content of a document row. */
export function matchesNeedle(
  row: Record<string, unknown>,
  needle: string,
): boolean {
  return ['title', 'slug', 'summary', 'content'].some((key) =>
    (str(row[key]) ?? '').toLowerCase().includes(needle),
  );
}

/**
 * A short window of `content` around the first case-insensitive hit of `needle` (already lower-cased), or null when
 * it isn't there — the match came from the title, slug or summary instead, which are shown on the row already.
 */
export function matchExcerpt(content: string, needle: string): string | null {
  const index = content.toLowerCase().indexOf(needle);
  if (index < 0) return null;
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(content.length, index + needle.length + EXCERPT_RADIUS);
  const flatten = (text: string) => text.replace(/\s+/gu, ' ').trim();
  return `${start > 0 ? '…' : ''}${flatten(content.slice(start, end))}${end < content.length ? '…' : ''}`;
}

/** A document summary, with `matchExcerpt` set when `needle` only matched the content. */
export function toSearchSummary(
  doc: KnowledgeDoc,
  needle: string | null | undefined,
): KnowledgeDocSummary {
  const summary = toSummary(doc);
  const excerpt = needle ? matchExcerpt(doc.content, needle) : null;
  return excerpt ? { ...summary, matchExcerpt: excerpt } : summary;
}

export async function mapVersions(
  conn: Conn,
  users: UserDirectory,
  rows: readonly Record<string, unknown>[],
): Promise<KnowledgeDocVersion[]> {
  const names = await actorNames(
    conn,
    users,
    rows.map((row) => ({ type: str(row.authorType), id: str(row.authorId) })),
  );
  return rows.map((row) => {
    const authorType = (str(row.authorType) ??
      'user') as KnowledgeVersionAuthorType;
    const authorId = str(row.authorId);
    return {
      docId: str(row.docId) ?? '',
      version: num(row.version, 1),
      title: str(row.title) ?? '',
      summary: str(row.summary) ?? '',
      content: str(row.content) ?? '',
      authorType,
      authorId,
      authorName: names.get(`${authorType}:${authorId}`) ?? null,
      sourceRunId: str(row.sourceRunId),
      proposalId: str(row.proposalId),
      note: str(row.note),
      createdAt: iso(row.createdAt),
    };
  });
}

function proposalStatus(value: unknown): KnowledgeProposalStatus {
  return value === 'accepted' || value === 'rejected' ? value : 'pending';
}

export async function mapProposals(
  conn: Conn,
  users: UserDirectory,
  rows: readonly Record<string, unknown>[],
  canDecide: (projectId: string | null) => boolean,
): Promise<KnowledgeProposal[]> {
  const docIds = unique(rows.map((row) => str(row.docId)));
  const docs = docIds.length
    ? await conn.query
        .selectFrom('knowledgeDocs')
        .select(['id', 'title', 'version'])
        .where('id', 'in', docIds)
        .execute()
    : [];
  const docTitles = new Map(
    docs.map((row) => [str(row.id) ?? '', str(row.title) ?? '']),
  );
  const docVersions = new Map(
    docs.map((row) => [str(row.id) ?? '', num(row.version, 1)]),
  );
  const projects = await projectNames(
    conn,
    rows.map((row) => str(row.projectId)),
  );
  const agents = await agentNames(
    conn,
    rows.map((row) => str(row.proposedByAgentId)),
  );
  const deciders = await users.names(
    conn,
    rows.map((row) => str(row.decidedById)),
  );
  const issueIds = unique(rows.map((row) => str(row.sourceIssueId)));
  const issues = issueIds.length
    ? await conn.query
        .selectFrom('issues')
        .select(['id', 'identifier'])
        .where('id', 'in', issueIds)
        .execute()
    : [];
  const identifiers = new Map(
    issues.map((row) => [str(row.id) ?? '', str(row.identifier) ?? '']),
  );
  return rows.map((row) => {
    const docId = str(row.docId);
    const projectId = projectIdOf(row.projectId);
    const title = str(row.title) ?? '';
    const status = proposalStatus(row.status);
    const decidedById = str(row.decidedById);
    const sourceIssueId = str(row.sourceIssueId);
    const agentId = str(row.proposedByAgentId) ?? '';
    const baseVersion = row.baseVersion;
    return {
      id: str(row.id) ?? '',
      docId,
      docTitle: (docId ? docTitles.get(docId) : null) ?? title,
      projectId,
      projectName: projectId ? (projects.get(projectId) ?? null) : null,
      title,
      slug: str(row.slug),
      summary: str(row.summary) ?? '',
      content: str(row.content) ?? '',
      reason: str(row.reason) ?? '',
      isNew: baseVersion === null || baseVersion === undefined,
      baseVersion:
        baseVersion === null || baseVersion === undefined
          ? null
          : num(baseVersion),
      currentVersion: docId ? (docVersions.get(docId) ?? null) : null,
      proposedByAgentId: agentId,
      proposedByAgentName: agents.get(agentId) ?? null,
      sourceRunId: str(row.sourceRunId),
      sourceIssueId,
      sourceIssueIdentifier: sourceIssueId
        ? (identifiers.get(sourceIssueId) ?? null)
        : null,
      status,
      decidedById,
      decidedByName: decidedById ? (deciders.get(decidedById) ?? null) : null,
      decidedAt: isoOrNull(row.decidedAt),
      comment: str(row.comment),
      canDecide: status === 'pending' && canDecide(projectId),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  });
}
