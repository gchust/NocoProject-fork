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
        .select(['id', 'title'])
        .where('id', 'in', docIds)
        .execute()
    : [];
  const docTitles = new Map(
    docs.map((row) => [str(row.id) ?? '', str(row.title) ?? '']),
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
