import { requireCapability } from '../agent/capabilities.js';
/**
 * Knowledge proposals (docs/phase1/iteration-3-contract.md §B): an agent suggests a change to a document (or a new
 * one) from its run; the decider accepts it into a new version or rejects it.
 *
 * - One pending proposal per document (or new slug) per run: a second is 409 `KNOWLEDGE_PROPOSAL_PENDING`.
 * - A proposal writes `knowledge_proposed` on the run's issue and emits `knowledge.proposed` with the deciders; the
 *   notification module turns that into `knowledge_proposal` decision cards.
 * - Accepting writes the new version (author: the proposing agent, with the run and proposal), `knowledge_updated`
 *   on the source issue, and emits `knowledge.decided` (cards resolve, the issue owner gets `knowledge_decided`).
 */
import type { Actor } from '../shared/activity.js';
import type { Conn } from '../shared/db.js';
import { now, num, str } from '../shared/db.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import type {
  AgentKnowledgeProposalRequest,
  DecideKnowledgeProposalRequest,
  KnowledgeProposal,
} from '../shared/protocol.js';
import {
  KNOWLEDGE_NOTE_MAX,
  KNOWLEDGE_REASON_MAX,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { findIssue } from '../issue/issue.records.js';
import type { RunAuth } from '../run/token.js';
import {
  agentDocRow,
  canEdit,
  canRead,
  knowledgeDeciders,
  scopeOf,
} from './knowledge.access.js';
import {
  findDocRow,
  findDocRowBySlug,
  mapProposals,
  projectIdOf,
  projectKey,
  projectNames,
  slugify,
  uniqueSlug,
  validateContent,
  validateSlug,
  validateSummary,
  validateTitle,
} from './knowledge.records.js';
import type { KnowledgeDeps } from './knowledge.service.js';
import { appendVersion, insertDoc } from './knowledge.write.js';

const NEVER = () => false;

export async function pendingForDoc(
  conn: Conn,
  users: UserDirectory,
  docId: string,
  canDecide: (projectId: string | null) => boolean,
): Promise<KnowledgeProposal[]> {
  const rows = await conn.query
    .selectFrom('knowledgeProposals')
    .selectAll()
    .where('docId', '=', docId)
    .where('status', '=', 'pending')
    .orderBy('createdAt', 'desc')
    .execute();
  return mapProposals(conn, users, rows, canDecide);
}

/** `GET /np/knowledge/proposals?status=pending`: the pending proposals the caller may decide, newest first. */
export async function listPendingProposals(
  deps: KnowledgeDeps,
  actor: Actor,
  status: string | null,
): Promise<KnowledgeProposal[]> {
  if (status !== null && status !== 'pending')
    throw invalid('INVALID_STATUS', 'Only status=pending is supported.');
  const conn = deps.tx.read();
  const scope = await scopeOf(conn, actor);
  const rows = (
    await conn.query
      .selectFrom('knowledgeProposals')
      .selectAll()
      .where('status', '=', 'pending')
      .orderBy('createdAt', 'desc')
      .execute()
  ).filter((row) => {
    const projectId = projectIdOf(row.projectId);
    return canRead(scope, projectId) && canEdit(scope, projectId);
  });
  return mapProposals(conn, deps.users, rows, (projectId) =>
    canEdit(scope, projectId),
  );
}

function validateReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || reason.length > KNOWLEDGE_REASON_MAX)
    throw invalid(
      'INVALID_REASON',
      `reason is required (at most ${KNOWLEDGE_REASON_MAX} characters).`,
    );
  return reason;
}

interface ProposalTarget {
  readonly docId: string | null;
  readonly docTitle: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly slug: string | null;
  readonly baseVersion: number | null;
}

/** Resolves what the proposal is about: an existing document the run may reach, or a new one in its scope. */
async function proposalTarget(
  conn: Conn,
  input: AgentKnowledgeProposalRequest,
  runProjectId: string | null,
): Promise<ProposalTarget> {
  if (input.docId) {
    const row = await agentDocRow(conn, input.docId, runProjectId);
    if (!row) throw notFound('Knowledge document');
    if (row.archivedAt)
      throw conflict('KNOWLEDGE_ARCHIVED', 'Archived documents are read-only.');
    return {
      docId: str(row.id),
      docTitle: str(row.title) ?? '',
      projectId: projectIdOf(row.projectId),
      title: input.title ? validateTitle(input.title) : '',
      slug: null,
      baseVersion: num(row.version, 1),
    };
  }
  const title = validateTitle(input.title);
  const slug = input.slug ? validateSlug(input.slug) : slugify(title);
  const projectId =
    input.projectId === undefined ? runProjectId : input.projectId || null;
  if (projectId !== null && projectId !== runProjectId)
    throw forbidden(
      'FORBIDDEN',
      "Agents may only propose documents for their run's project or system-level ones.",
    );
  if (await findDocRowBySlug(conn, projectKey(projectId), slug))
    throw conflict(
      'KNOWLEDGE_SLUG_TAKEN',
      `A document with slug ${slug} exists; propose a change to it with docId.`,
    );
  return {
    docId: null,
    docTitle: title,
    projectId,
    title,
    slug,
    baseVersion: null,
  };
}

async function assertNoPending(
  conn: Conn,
  target: ProposalTarget,
  runId: string,
): Promise<void> {
  let select = conn.query
    .selectFrom('knowledgeProposals')
    .select('id')
    .where('status', '=', 'pending')
    .where('sourceRunId', '=', runId);
  select = target.docId
    ? select.where('docId', '=', target.docId)
    : select
        .where('docId', 'is', null)
        .where('slug', '=', target.slug ?? '')
        .where('projectId', target.projectId ? '=' : 'is', target.projectId);
  if (await select.exists())
    throw conflict(
      'KNOWLEDGE_PROPOSAL_PENDING',
      'This run already has a pending proposal for this document.',
    );
}

export async function agentPropose(
  deps: KnowledgeDeps,
  auth: RunAuth,
  input: AgentKnowledgeProposalRequest,
): Promise<KnowledgeProposal> {
  const content = validateContent(input?.content);
  const reason = validateReason(input.reason);
  const summary = validateSummary(input.summary);
  const id = await deps.tx.run(async (tx) => {
    await requireCapability(tx.conn, auth, 'knowledge.propose');
    const issue = await findIssue(tx.conn, auth.issueId);
    const target = await proposalTarget(
      tx.conn,
      input,
      issue?.projectId ?? null,
    );
    await assertNoPending(tx.conn, target, auth.runId);
    const proposalId = deps.ids.next();
    const timestamp = now();
    await tx.conn.query
      .insertInto('knowledgeProposals')
      .values({
        id: proposalId,
        docId: target.docId,
        projectId: target.projectId,
        title: target.title,
        slug: target.slug,
        summary,
        content,
        reason,
        baseVersion: target.baseVersion,
        proposedByAgentId: auth.agentId,
        sourceRunId: auth.runId,
        sourceIssueId: issue?.id ?? null,
        status: 'pending',
        decidedById: null,
        decidedAt: null,
        comment: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
    const isNew = target.docId === null;
    const actor = { type: 'agent' as const, id: auth.agentId };
    if (issue) {
      await deps.activity.record(tx.conn, {
        issueId: issue.id,
        actor: { ...actor, runId: auth.runId },
        action: 'knowledge_proposed',
        details: {
          proposalId,
          docId: target.docId,
          title: target.docTitle,
          isNew,
        },
      });
      tx.emit({ type: 'issue.changed', issueId: issue.id });
    }
    const projects = await projectNames(tx.conn, [target.projectId]);
    tx.emit({
      type: 'knowledge.proposed',
      proposalId,
      docId: target.docId,
      docTitle: target.docTitle,
      projectId: target.projectId,
      projectName: target.projectId
        ? (projects.get(target.projectId) ?? null)
        : null,
      reason,
      summary,
      isNew,
      issueId: issue?.id ?? null,
      deciderUserIds: await knowledgeDeciders(tx.conn, target.projectId),
      actor,
    });
    return proposalId;
  });
  return loadProposal(deps, deps.tx.read(), id, NEVER);
}

async function loadProposal(
  deps: KnowledgeDeps,
  conn: Conn,
  id: string,
  canDecide: (projectId: string | null) => boolean,
): Promise<KnowledgeProposal> {
  const row = await conn.query
    .selectFrom('knowledgeProposals')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Knowledge proposal');
  return (await mapProposals(conn, deps.users, [row], canDecide))[0];
}

/** Applies an accepted proposal: a new version of its document, or a new document. */
async function applyProposal(
  deps: KnowledgeDeps,
  conn: Conn,
  row: Record<string, unknown>,
  comment: string | null,
): Promise<{ docId: string; docTitle: string; version: number }> {
  const author = {
    type: 'agent' as const,
    id: str(row.proposedByAgentId),
    sourceRunId: str(row.sourceRunId),
    proposalId: str(row.id),
    note: comment,
  };
  const docId = str(row.docId);
  const title = str(row.title) ?? '';
  const summary = str(row.summary) ?? '';
  if (docId) {
    const doc = await findDocRow(conn, docId);
    if (!doc) throw notFound('Knowledge document');
    if (doc.archivedAt)
      throw conflict('KNOWLEDGE_ARCHIVED', 'Archived documents are read-only.');
    const next = {
      title: title || (str(doc.title) ?? ''),
      summary: summary || (str(doc.summary) ?? ''),
      content: str(row.content) ?? '',
    };
    const version = await appendVersion(
      conn,
      deps.ids,
      docId,
      num(doc.version, 1),
      next,
      author,
    );
    return { docId, docTitle: next.title, version };
  }
  const projectId = projectIdOf(row.projectId);
  if (projectId && (await projectNames(conn, [projectId])).size === 0)
    throw conflict(
      'KNOWLEDGE_PROPOSAL_STALE',
      'The project of this proposal no longer exists.',
    );
  const key = projectKey(projectId);
  const slug = await uniqueSlug(conn, key, str(row.slug) ?? slugify(title));
  const newId = await insertDoc(
    conn,
    deps.ids,
    { projectId, title, slug, summary, content: str(row.content) ?? '' },
    author,
  );
  return { docId: newId, docTitle: title, version: 1 };
}

function validateComment(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > KNOWLEDGE_NOTE_MAX)
    throw invalid(
      'INVALID_COMMENT',
      `comment must be text of at most ${KNOWLEDGE_NOTE_MAX} characters.`,
    );
  return value;
}

export async function decideProposal(
  deps: KnowledgeDeps,
  actor: Actor,
  proposalId: string,
  decision: 'accept' | 'reject',
  input: DecideKnowledgeProposalRequest,
): Promise<KnowledgeProposal> {
  const comment = validateComment(input?.comment);
  await deps.tx.run(async (tx) => {
    const scope = await scopeOf(tx.conn, actor);
    const row = await tx.conn.query
      .selectFrom('knowledgeProposals')
      .selectAll()
      .where('id', '=', proposalId)
      .executeTakeFirst();
    const projectId = row ? projectIdOf(row.projectId) : null;
    if (!row || !canRead(scope, projectId))
      throw notFound('Knowledge proposal');
    if (!canEdit(scope, projectId))
      throw forbidden(
        'FORBIDDEN',
        'Only the project lead or an owner/admin may decide this proposal.',
      );
    if (row.status !== 'pending')
      throw conflict(
        'KNOWLEDGE_PROPOSAL_DECIDED',
        'This proposal has already been decided.',
      );
    const applied =
      decision === 'accept'
        ? await applyProposal(deps, tx.conn, row, comment)
        : null;
    const timestamp = now();
    const result = await tx.conn.query
      .updateTable('knowledgeProposals')
      .set({
        status: decision === 'accept' ? 'accepted' : 'rejected',
        ...(applied ? { docId: applied.docId } : {}),
        decidedById: actor.id,
        decidedAt: timestamp,
        comment,
        updatedAt: timestamp,
      })
      .where('id', '=', proposalId)
      .where('status', '=', 'pending')
      .execute();
    if (num(result.updatedCount) === 0)
      throw conflict(
        'KNOWLEDGE_PROPOSAL_DECIDED',
        'This proposal has already been decided.',
      );
    const issue = str(row.sourceIssueId)
      ? await findIssue(tx.conn, str(row.sourceIssueId) ?? '')
      : null;
    const docTitle = applied?.docTitle ?? (await docTitleOf(tx.conn, row));
    if (issue && applied) {
      await deps.activity.record(tx.conn, {
        issueId: issue.id,
        actor,
        action: 'knowledge_updated',
        details: {
          proposalId,
          docId: applied.docId,
          version: applied.version,
          title: applied.docTitle,
          isNew: !str(row.docId),
        },
      });
    }
    if (issue) tx.emit({ type: 'issue.changed', issueId: issue.id });
    tx.emit({
      type: 'knowledge.decided',
      proposalId,
      docId: applied?.docId ?? str(row.docId),
      docTitle,
      decision: applied ? 'accepted' : 'rejected',
      version: applied?.version ?? null,
      comment,
      issueId: issue?.id ?? null,
      actor: { type: 'user', id: actor.id },
    });
  });
  const conn = deps.tx.read();
  const scope = await scopeOf(conn, actor);
  return loadProposal(deps, conn, proposalId, (projectId) =>
    canEdit(scope, projectId),
  );
}

async function docTitleOf(
  conn: Conn,
  row: Record<string, unknown>,
): Promise<string> {
  const docId = str(row.docId);
  const doc = docId ? await findDocRow(conn, docId) : undefined;
  return str(doc?.title) ?? str(row.title) ?? '';
}
