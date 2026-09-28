/**
 * Knowledge writes shared by human edits and accepted proposals: a new document (version 1) and a new version of an
 * existing one. Every version is kept in `knowledgeDocVersions`; the document row holds the latest.
 */
import type { Conn } from '../shared/db.js';
import { isUniqueViolation, now, num } from '../shared/db.js';
import { conflict } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import { projectKey } from './knowledge.records.js';

export interface DocAuthor {
  readonly type: 'user' | 'agent';
  readonly id: string | null;
  readonly sourceRunId?: string | null;
  readonly proposalId?: string | null;
  readonly note?: string | null;
}

export interface DocContent {
  readonly title: string;
  readonly summary: string;
  readonly content: string;
}

async function insertVersion(
  conn: Conn,
  ids: IdSource,
  docId: string,
  version: number,
  content: DocContent,
  author: DocAuthor,
  timestamp: Date,
): Promise<void> {
  await conn.query
    .insertInto('knowledgeDocVersions')
    .values({
      id: ids.next(),
      docId,
      version,
      title: content.title,
      content: content.content,
      summary: content.summary,
      authorType: author.type,
      authorId: author.id,
      sourceRunId: author.sourceRunId ?? null,
      proposalId: author.proposalId ?? null,
      note: author.note ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
}

/** Inserts a document at version 1; a slug taken concurrently is 409 `KNOWLEDGE_SLUG_TAKEN`. */
export async function insertDoc(
  conn: Conn,
  ids: IdSource,
  input: DocContent & {
    readonly projectId: string | null;
    readonly slug: string;
  },
  author: DocAuthor,
): Promise<string> {
  const id = ids.next();
  const timestamp = now();
  try {
    await conn.transaction(async (inner) => {
      await inner.query
        .insertInto('knowledgeDocs')
        .values({
          id,
          projectId: projectKey(input.projectId),
          title: input.title,
          slug: input.slug,
          summary: input.summary,
          content: input.content,
          version: 1,
          updatedByType: author.type,
          updatedById: author.id,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute();
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict(
        'KNOWLEDGE_SLUG_TAKEN',
        `The slug ${input.slug} is already used in this scope.`,
      );
    throw error;
  }
  await insertVersion(conn, ids, id, 1, input, author, timestamp);
  return id;
}

/**
 * Writes the next version of a document that is at `expectedVersion`; 409 `KNOWLEDGE_VERSION_CONFLICT` when it moved
 * on meanwhile. Returns the new version number.
 */
export async function appendVersion(
  conn: Conn,
  ids: IdSource,
  docId: string,
  expectedVersion: number,
  content: DocContent,
  author: DocAuthor,
): Promise<number> {
  const version = expectedVersion + 1;
  const timestamp = now();
  const result = await conn.query
    .updateTable('knowledgeDocs')
    .set({
      title: content.title,
      summary: content.summary,
      content: content.content,
      version,
      updatedByType: author.type,
      updatedById: author.id,
      updatedAt: timestamp,
    })
    .where('id', '=', docId)
    .where('version', '=', expectedVersion)
    .execute();
  if (num(result.updatedCount) === 0)
    throw conflict(
      'KNOWLEDGE_VERSION_CONFLICT',
      'The document was changed meanwhile; reload it and try again.',
    );
  await insertVersion(conn, ids, docId, version, content, author, timestamp);
  return version;
}
