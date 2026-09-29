import { requireCapability } from '../agent/capabilities.js';
/**
 * Knowledge base v0 (docs/phase1/iteration-3-contract.md §B): project or system-level Markdown documents that people
 * write and keep, and that agents read on demand. Agents only propose changes (`knowledge.proposals.ts`); the project
 * lead (owner/admin when there is none, or for system documents) accepts a proposal into a new version.
 *
 * Every edit is a new version (`knowledgeDocVersions`); a human edit names the version it started from
 * (`expectedVersion`) and a stale one is 409 `KNOWLEDGE_VERSION_CONFLICT`. Archived documents are read-only and hidden
 * from agents. Permissions: `knowledge.access.ts`.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { now, str } from '../shared/db.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AgentKnowledgeProposalRequest,
  ClaimedKnowledgeDoc,
  CreateKnowledgeDocRequest,
  DecideKnowledgeProposalRequest,
  KnowledgeDoc,
  KnowledgeDocDetail,
  KnowledgeDocSummary,
  KnowledgeDocVersion,
  KnowledgeProposal,
  MoveKnowledgeDocRequest,
  UpdateKnowledgeDocRequest,
} from '../shared/protocol.js';
import { KNOWLEDGE_MAX_DEPTH, KNOWLEDGE_NOTE_MAX } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import type { RunAuth } from '../run/token.js';
import {
  agentDocRow,
  canEdit,
  canRead,
  runProject,
  scopeOf,
  type KnowledgeScope,
} from './knowledge.access.js';
import {
  agentPropose,
  decideProposal,
  listPendingProposals,
  pendingForDoc,
} from './knowledge.proposals.js';
import {
  breadcrumbsOf,
  childCounts,
  decorateDocs,
  depthOf,
  findDocRow,
  findDocRowBySlug,
  isSelfOrDescendant,
  mapVersions,
  matchesNeedle,
  nextSortOrder,
  projectIdOf,
  projectKey,
  slugify,
  subtreeHeight,
  SYSTEM_PROJECT_KEY,
  toSearchSummary,
  uniqueSlug,
  validateContent,
  validateSlug,
  validateSummary,
  validateTitle,
} from './knowledge.records.js';
import { appendVersion, insertDoc, moveDoc } from './knowledge.write.js';

export interface KnowledgeListQuery {
  /** A project id, `none` for system-level documents only; absent = every visible project + system-level. */
  readonly projectId?: string | null;
  readonly q?: string | null;
  readonly includeArchived?: boolean;
}

export interface KnowledgeService {
  list(actor: Actor, query: KnowledgeListQuery): Promise<KnowledgeDocSummary[]>;
  create(
    actor: Actor,
    input: CreateKnowledgeDocRequest,
  ): Promise<KnowledgeDocDetail>;
  detail(actor: Actor, id: string): Promise<KnowledgeDocDetail>;
  update(
    actor: Actor,
    id: string,
    input: UpdateKnowledgeDocRequest,
  ): Promise<KnowledgeDocDetail>;
  /** Moves a document to a new parent/position (NP-147); does not create a new content version. */
  move(
    actor: Actor,
    id: string,
    input: MoveKnowledgeDocRequest,
  ): Promise<KnowledgeDocDetail>;
  version(
    actor: Actor,
    id: string,
    version: number,
  ): Promise<KnowledgeDocVersion>;
  setArchived(
    actor: Actor,
    id: string,
    archived: boolean,
  ): Promise<KnowledgeDocDetail>;
  /** The project's own live documents (project detail `knowledgeDocs`). */
  projectDocs(actor: Actor, projectId: string): Promise<KnowledgeDocSummary[]>;
  proposals(actor: Actor, status: string | null): Promise<KnowledgeProposal[]>;
  decide(
    actor: Actor,
    proposalId: string,
    decision: 'accept' | 'reject',
    input: DecideKnowledgeProposalRequest,
  ): Promise<KnowledgeProposal>;
  /** `q` matches the same fields as the browser list (title, slug, summary, content). */
  agentList(auth: RunAuth, q?: string | null): Promise<KnowledgeDocSummary[]>;
  agentGet(auth: RunAuth, idOrSlug: string): Promise<KnowledgeDoc>;
  agentPropose(
    auth: RunAuth,
    input: AgentKnowledgeProposalRequest,
  ): Promise<KnowledgeProposal>;
  /** The claim payload index: the project's live documents, then system-level ones. */
  claimIndex(
    conn: Conn,
    projectId: string | null,
  ): Promise<ClaimedKnowledgeDoc[]>;
}

export interface KnowledgeDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
}

function decoration(deps: KnowledgeDeps, scope: KnowledgeScope | null) {
  return {
    users: deps.users,
    canEdit: (projectId: string | null) =>
      scope ? canEdit(scope, projectId) : false,
  };
}

/** The document row, or 404 when it does not exist, its project is gone or the viewer cannot see it. */
async function requireDoc(
  deps: KnowledgeDeps,
  conn: Conn,
  scope: KnowledgeScope,
  id: string,
): Promise<KnowledgeDoc> {
  const row = await findDocRow(conn, id);
  if (!row || !canRead(scope, projectIdOf(row.projectId)))
    throw notFound('Knowledge document');
  const [doc] = await decorateDocs(conn, decoration(deps, scope), [row]);
  if (!doc) throw notFound('Knowledge document');
  return doc;
}

function requireEdit(scope: KnowledgeScope, projectId: string | null): void {
  if (!canEdit(scope, projectId))
    throw forbidden(
      'FORBIDDEN',
      projectId
        ? 'Only the project lead or an owner/admin may change project knowledge.'
        : 'Only an owner or admin may change system-level knowledge.',
    );
}

async function detailOf(
  deps: KnowledgeDeps,
  conn: Conn,
  scope: KnowledgeScope,
  doc: KnowledgeDoc,
): Promise<KnowledgeDocDetail> {
  const rows = await conn.query
    .selectFrom('knowledgeDocVersions')
    .selectAll()
    .where('docId', '=', doc.id)
    .orderBy('version', 'desc')
    .execute();
  const versions = (await mapVersions(conn, deps.users, rows)).map(
    ({ content: _content, ...summary }) => summary,
  );
  return {
    doc,
    versions,
    proposals: await pendingForDoc(conn, deps.users, doc.id, (projectId) =>
      canEdit(scope, projectId),
    ),
    breadcrumbs: await breadcrumbsOf(conn, doc.id),
  };
}

async function list(
  deps: KnowledgeDeps,
  actor: Actor,
  query: KnowledgeListQuery,
): Promise<KnowledgeDocSummary[]> {
  const conn = deps.tx.read();
  const scope = await scopeOf(conn, actor);
  let select = conn.query.selectFrom('knowledgeDocs').selectAll();
  if (query.projectId === 'none')
    select = select.where('projectId', '=', SYSTEM_PROJECT_KEY);
  else if (query.projectId)
    select = select.where('projectId', '=', query.projectId);
  if (!query.includeArchived) select = select.where('archivedAt', 'is', null);
  const rows = (await select.orderBy('title', 'asc').execute()).filter((row) =>
    canRead(scope, projectIdOf(row.projectId)),
  );
  const needle = query.q?.trim().toLowerCase();
  const matched = needle
    ? rows.filter((row) => matchesNeedle(row, needle))
    : rows;
  const docs = await decorateDocs(conn, decoration(deps, scope), matched);
  return docs.map((doc) => toSearchSummary(doc, needle));
}

async function create(
  deps: KnowledgeDeps,
  actor: Actor,
  input: CreateKnowledgeDocRequest,
): Promise<KnowledgeDocDetail> {
  const title = validateTitle(input?.title);
  const summary = validateSummary(input.summary);
  const content = validateContent(input.content);
  const slugInput =
    input.slug === undefined || input.slug === ''
      ? null
      : validateSlug(input.slug);
  const id = await deps.tx.run(async (tx) => {
    const scope = await scopeOf(tx.conn, actor);
    const projectId = input.projectId ? input.projectId : null;
    if (projectId) {
      const exists = await tx.conn.query
        .selectFrom('projects')
        .select('id')
        .where('id', '=', projectId)
        .exists();
      if (!exists || !canRead(scope, projectId))
        throw invalid('INVALID_PROJECT', 'projectId does not exist.');
    }
    requireEdit(scope, projectId);
    const key = projectKey(projectId);
    const parentId = await resolveParent(tx.conn, key, input.parentId ?? null);
    if (slugInput && (await findDocRowBySlug(tx.conn, key, slugInput)))
      throw conflict(
        'KNOWLEDGE_SLUG_TAKEN',
        `The slug ${slugInput} is already used in this scope.`,
      );
    const slug = slugInput ?? (await uniqueSlug(tx.conn, key, slugify(title)));
    const sortOrder = await nextSortOrder(tx.conn, key, parentId);
    return insertDoc(
      tx.conn,
      deps.ids,
      { projectId, title, slug, summary, content, parentId, sortOrder },
      { type: 'user', id: actor.id },
    );
  });
  return detail(deps, actor, id);
}

/** Validates a create `parentId`: it must be a live, non-archived document in the same scope, within depth. */
async function resolveParent(
  conn: Conn,
  key: string,
  parentId: string | null,
): Promise<string | null> {
  if (!parentId) return null;
  const parentRow = await findDocRow(conn, parentId);
  if (!parentRow || str(parentRow.projectId) !== key)
    throw invalid(
      'INVALID_PARENT',
      'parentId must be a document in the same scope.',
    );
  if (parentRow.archivedAt)
    throw conflict(
      'KNOWLEDGE_ARCHIVED',
      'Cannot place a document under an archived parent.',
    );
  const parentDepth = await depthOf(conn, parentId);
  if (parentDepth + 1 > KNOWLEDGE_MAX_DEPTH)
    throw invalid(
      'KNOWLEDGE_DEPTH_EXCEEDED',
      `Documents can be nested at most ${KNOWLEDGE_MAX_DEPTH} levels deep.`,
    );
  return parentId;
}

async function detail(
  deps: KnowledgeDeps,
  actor: Actor,
  id: string,
): Promise<KnowledgeDocDetail> {
  const conn = deps.tx.read();
  const scope = await scopeOf(conn, actor);
  return detailOf(deps, conn, scope, await requireDoc(deps, conn, scope, id));
}

async function update(
  deps: KnowledgeDeps,
  actor: Actor,
  id: string,
  input: UpdateKnowledgeDocRequest,
): Promise<KnowledgeDocDetail> {
  if (!Number.isInteger(input?.expectedVersion))
    throw invalid('VERSION_REQUIRED', 'expectedVersion is required.');
  if (
    input.note !== undefined &&
    (typeof input.note !== 'string' || input.note.length > KNOWLEDGE_NOTE_MAX)
  )
    throw invalid(
      'INVALID_NOTE',
      `note must be text of at most ${KNOWLEDGE_NOTE_MAX} characters.`,
    );
  await deps.tx.run(async (tx) => {
    const scope = await scopeOf(tx.conn, actor);
    const doc = await requireDoc(deps, tx.conn, scope, id);
    requireEdit(scope, doc.projectId);
    if (doc.archivedAt)
      throw conflict('KNOWLEDGE_ARCHIVED', 'Archived documents are read-only.');
    if (doc.version !== input.expectedVersion)
      throw conflict(
        'KNOWLEDGE_VERSION_CONFLICT',
        `The document is at version ${doc.version}.`,
      );
    const next = {
      title: input.title === undefined ? doc.title : validateTitle(input.title),
      summary:
        input.summary === undefined
          ? doc.summary
          : validateSummary(input.summary),
      content:
        input.content === undefined
          ? doc.content
          : validateContent(input.content),
    };
    if (
      next.title === doc.title &&
      next.summary === doc.summary &&
      next.content === doc.content
    )
      return;
    await appendVersion(tx.conn, deps.ids, doc.id, doc.version, next, {
      type: 'user',
      id: actor.id,
      note: input.note ?? null,
    });
  });
  return detail(deps, actor, id);
}

/**
 * Moves a document to a new parent and/or position (NP-147). Same scope only, cannot move under its own descendant,
 * depth limit enforced against the moved document's whole subtree, same permission as editing. `expectedVersion` is
 * optional here (a move never changes it) and, when given, only guards against a content change since it was read.
 */
async function move(
  deps: KnowledgeDeps,
  actor: Actor,
  id: string,
  input: MoveKnowledgeDocRequest,
): Promise<KnowledgeDocDetail> {
  if (input.parentId !== null && typeof input.parentId !== 'string')
    throw invalid('INVALID_PARENT', 'parentId must be a document id or null.');
  if (!Number.isInteger(input.sortOrder))
    throw invalid('INVALID_SORT_ORDER', 'sortOrder must be an integer.');
  if (
    input.expectedVersion !== undefined &&
    !Number.isInteger(input.expectedVersion)
  )
    throw invalid(
      'INVALID_VERSION',
      'expectedVersion must be an integer when given.',
    );
  await deps.tx.run(async (tx) => {
    const scope = await scopeOf(tx.conn, actor);
    const doc = await requireDoc(deps, tx.conn, scope, id);
    requireEdit(scope, doc.projectId);
    if (doc.archivedAt)
      throw conflict('KNOWLEDGE_ARCHIVED', 'Archived documents are read-only.');
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== doc.version
    )
      throw conflict(
        'KNOWLEDGE_VERSION_CONFLICT',
        `The document is at version ${doc.version}.`,
      );
    const key = projectKey(doc.projectId);
    let parentId: string | null = null;
    if (input.parentId) {
      const parentRow = await findDocRow(tx.conn, input.parentId);
      if (!parentRow || str(parentRow.projectId) !== key)
        throw invalid(
          'INVALID_PARENT',
          'parentId must be a document in the same scope.',
        );
      if (parentRow.archivedAt)
        throw conflict(
          'KNOWLEDGE_ARCHIVED',
          'Cannot move a document under an archived parent.',
        );
      if (await isSelfOrDescendant(tx.conn, input.parentId, doc.id))
        throw conflict(
          'KNOWLEDGE_INVALID_MOVE',
          'Cannot move a document under itself or one of its own descendants.',
        );
      parentId = input.parentId;
    }
    const parentDepth = parentId ? await depthOf(tx.conn, parentId) : 0;
    const height = await subtreeHeight(tx.conn, doc.id);
    if (parentDepth + 1 + (height - 1) > KNOWLEDGE_MAX_DEPTH)
      throw invalid(
        'KNOWLEDGE_DEPTH_EXCEEDED',
        `Documents can be nested at most ${KNOWLEDGE_MAX_DEPTH} levels deep.`,
      );
    await moveDoc(tx.conn, doc.id, parentId, input.sortOrder, {
      type: 'user',
      id: actor.id,
    });
  });
  return detail(deps, actor, id);
}

async function version(
  deps: KnowledgeDeps,
  actor: Actor,
  id: string,
  number: number,
): Promise<KnowledgeDocVersion> {
  const conn = deps.tx.read();
  const scope = await scopeOf(conn, actor);
  const doc = await requireDoc(deps, conn, scope, id);
  const row = await conn.query
    .selectFrom('knowledgeDocVersions')
    .selectAll()
    .where('docId', '=', doc.id)
    .where('version', '=', number)
    .executeTakeFirst();
  if (!row) throw notFound('Knowledge version');
  return (await mapVersions(conn, deps.users, [row]))[0];
}

async function setArchived(
  deps: KnowledgeDeps,
  actor: Actor,
  id: string,
  archived: boolean,
): Promise<KnowledgeDocDetail> {
  await deps.tx.run(async (tx) => {
    const scope = await scopeOf(tx.conn, actor);
    const doc = await requireDoc(deps, tx.conn, scope, id);
    requireEdit(scope, doc.projectId);
    if (!!doc.archivedAt === archived) return;
    if (archived) {
      const hasLiveChildren = await tx.conn.query
        .selectFrom('knowledgeDocs')
        .select('id')
        .where('parentId', '=', doc.id)
        .where('archivedAt', 'is', null)
        .exists();
      if (hasLiveChildren)
        throw conflict(
          'KNOWLEDGE_HAS_CHILDREN',
          'Move or archive the child documents first.',
        );
    }
    await tx.conn.query
      .updateTable('knowledgeDocs')
      .set({ archivedAt: archived ? now() : null })
      .where('id', '=', doc.id)
      .execute();
  });
  return detail(deps, actor, id);
}

async function agentRows(
  conn: Conn,
  projectId: string | null,
): Promise<Record<string, unknown>[]> {
  const keys = projectId
    ? [projectId, SYSTEM_PROJECT_KEY]
    : [SYSTEM_PROJECT_KEY];
  const rows = await conn.query
    .selectFrom('knowledgeDocs')
    .selectAll()
    .where('projectId', 'in', keys)
    .where('archivedAt', 'is', null)
    .orderBy('title', 'asc')
    .execute();
  // The run's project first, then system-level documents.
  return [
    ...rows.filter((row) => str(row.projectId) !== SYSTEM_PROJECT_KEY),
    ...rows.filter((row) => str(row.projectId) === SYSTEM_PROJECT_KEY),
  ];
}

async function agentGet(
  deps: KnowledgeDeps,
  auth: RunAuth,
  idOrSlug: string,
): Promise<KnowledgeDoc> {
  const conn = deps.tx.read();
  await requireCapability(conn, auth, 'context.read');
  const row = await agentDocRow(conn, idOrSlug, await runProject(conn, auth));
  if (!row || row.archivedAt) throw notFound('Knowledge document');
  const [doc] = await decorateDocs(conn, decoration(deps, null), [row]);
  if (!doc) throw notFound('Knowledge document');
  return doc;
}

export function createKnowledgeService(deps: KnowledgeDeps): KnowledgeService {
  return {
    list: (actor, query) => list(deps, actor, query),
    create: (actor, input) => create(deps, actor, input),
    detail: (actor, id) => detail(deps, actor, id),
    update: (actor, id, input) => update(deps, actor, id, input),
    move: (actor, id, input) => move(deps, actor, id, input),
    version: (actor, id, number) => version(deps, actor, id, number),
    setArchived: (actor, id, archived) =>
      setArchived(deps, actor, id, archived),
    projectDocs: (actor, projectId) => list(deps, actor, { projectId }),
    proposals: (actor, status) => listPendingProposals(deps, actor, status),
    decide: (actor, proposalId, decision, input) =>
      decideProposal(deps, actor, proposalId, decision, input),
    async agentList(auth, q) {
      const conn = deps.tx.read();
      await requireCapability(conn, auth, 'context.read');
      const rows = await agentRows(conn, await runProject(conn, auth));
      const needle = q?.trim().toLowerCase();
      const matched = needle
        ? rows.filter((row) => matchesNeedle(row, needle))
        : rows;
      const docs = await decorateDocs(conn, decoration(deps, null), matched);
      return docs.map((doc) => toSearchSummary(doc, needle));
    },
    agentGet: (auth, idOrSlug) => agentGet(deps, auth, idOrSlug),
    agentPropose: (auth, input) => agentPropose(deps, auth, input),
    async claimIndex(conn, projectId) {
      const rows = (await agentRows(conn, projectId)).filter(
        (row) => !str(row.parentId),
      );
      const children = await childCounts(
        conn,
        rows.map((row) => str(row.id) ?? ''),
      );
      return rows.map((row) => {
        const id = str(row.id) ?? '';
        return {
          id,
          slug: str(row.slug) ?? '',
          title: str(row.title) ?? '',
          summary: str(row.summary) ?? '',
          projectId: projectIdOf(row.projectId),
          childCount: children.get(id) ?? 0,
        };
      });
    },
  };
}
