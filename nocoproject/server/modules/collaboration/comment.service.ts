import { requireActorCapability } from '../agent/capabilities.js';
/**
 * Comments on issues: human comments from the browser (which may trigger agents) and agent comments written back
 * through a run token (which never trigger anything). Iteration 2: rows carry their reactions and, on thread roots,
 * whether the thread is resolved (`reaction.service.ts` writes both).
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  requireInvokeAgent,
  requireEditIssues,
  requireVisibleIssue,
  viewerOf,
} from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import {
  fromJson,
  iso,
  isoOrNull,
  now,
  str,
  toDate,
  toJson,
  unique,
} from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import { decodeCursor, encodeCursor } from '../shared/pagination.js';
import type {
  ActorType,
  CommentForAgentV2,
  CommentPage,
  CommentReaction,
  CommentV2,
  CommentPmFields,
  CreateCommentRequest,
  CreateCommentRequestPm,
  CreateCommentResponse,
  PmResolvedContext,
} from '../shared/protocol.js';
import { REACTION_EMOJIS } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { findIssue } from '../issue/issue.records.js';
import { agentNames } from '../run/run.queries.js';
import type { ConversationService } from '../pm/pm.conversations.js';
import type { TriggerService } from '../trigger/trigger.service.js';
import { isNote, parseMentions, parseUserMentions } from './mentions.js';

const MAX_CONTENT_LENGTH = 200_000;

export interface AgentCommentQuery {
  /** Only comments created after this instant. */
  readonly since?: string | null;
  readonly rootsOnly?: boolean;
  /** Only this thread (root comment id). */
  readonly thread?: string | null;
  /** Only the last n comments of the result. */
  readonly tail?: number | null;
  /** Leave out resolved threads (except the `thread` asked for). */
  readonly excludeResolved?: boolean;
}

/** Iteration 3: the delivery endpoints compose a comment into their transaction. */
export interface CommentCreateOptions {
  /** Joins the caller's transaction. */
  readonly outer?: Tx;
  /** false = record the comment without running the trigger rules (an acceptance note). Default true. */
  readonly trigger?: boolean;
  /** Iteration 4: `proposal` = a design proposal (a top-level comment; agent comments never trigger). */
  readonly kind?: 'proposal';
}

export interface CommentService {
  create(
    actor: Actor,
    issueIdOrKey: string,
    input: CreateCommentRequest,
    options?: CommentCreateOptions,
  ): Promise<CreateCommentResponse>;
  /** Every comment of an issue, flat, oldest first. */
  listForIssue(conn: Conn, issueId: string): Promise<CommentV2[]>;
  /**
   * One page of an issue's comments (iteration 3 §D): a newest-first slice returned oldest first; `nextCursor` asks
   * for the slice before it (null when there is none).
   */
  pageForIssue(
    conn: Conn,
    issueId: string,
    cursor: string | null,
    limit: number,
  ): Promise<CommentPage>;
  listForAgent(
    issueIdOrKey: string,
    query: AgentCommentQuery,
  ): Promise<CommentForAgentV2[]>;
}

export interface CommentDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly triggers: () => TriggerService;
  /** NP-183: project manager conversations (page context, titles, agent binding); absent = none. */
  readonly conversations?: () => Pick<ConversationService, 'onMessage'>;
}

function isActorType(value: unknown): value is ActorType {
  return value === 'user' || value === 'agent' || value === 'system';
}

/** Reactions per comment, in the fixed emoji order. */
export async function reactionsFor(
  conn: Conn,
  commentIds: readonly string[],
): Promise<Map<string, CommentReaction[]>> {
  const result = new Map<string, CommentReaction[]>();
  const ids = unique(commentIds);
  if (ids.length === 0) return result;
  const rows = await conn.query
    .selectFrom('commentReactions')
    .select(['commentId', 'userId', 'emoji'])
    .where('commentId', 'in', ids)
    .orderBy('createdAt', 'asc')
    .execute();
  const grouped = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const commentId = str(row.commentId) ?? '';
    const byEmoji = grouped.get(commentId) ?? new Map<string, string[]>();
    grouped.set(commentId, byEmoji);
    const emoji = str(row.emoji) ?? '';
    byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), str(row.userId) ?? '']);
  }
  for (const [commentId, byEmoji] of grouped) {
    result.set(
      commentId,
      REACTION_EMOJIS.filter((emoji) => byEmoji.has(emoji)).map((emoji) => {
        const userIds = byEmoji.get(emoji) ?? [];
        return { emoji: emoji, count: userIds.length, userIds };
      }),
    );
  }
  return result;
}

const COMMENT_KINDS = ['system', 'proposal', 'plan', 'plan_result'];

type CommentV5 = CommentV2 & CommentPmFields;

async function mapComments(
  conn: Conn,
  users: UserDirectory,
  rows: readonly Record<string, unknown>[],
): Promise<CommentV5[]> {
  const userIds = rows
    .filter((row) => row.authorType === 'user')
    .map((row) => str(row.authorId));
  const agentIds = rows
    .filter((row) => row.authorType === 'agent')
    .map((row) => str(row.authorId));
  const userNames = await users.names(conn, [
    ...userIds,
    ...rows.map((row) => str(row.resolvedById)),
  ]);
  const reactions = await reactionsFor(
    conn,
    rows.map((row) => str(row.id) ?? ''),
  );
  const agents = await agentNames(conn, agentIds);
  return rows.map((row) => {
    const id = str(row.id) ?? '';
    const authorType = isActorType(row.authorType) ? row.authorType : 'system';
    const authorId = str(row.authorId);
    const authorName =
      authorType === 'system'
        ? 'system'
        : ((authorType === 'agent' ? agents : userNames).get(authorId ?? '') ??
          authorId ??
          '');
    return {
      id,
      issueId: str(row.issueId) ?? '',
      authorType,
      authorId,
      authorName,
      content: str(row.content) ?? '',
      // Iteration 4 adds `proposal` (CommentKindV4), NP-183 `plan` / `plan_result`; the iteration-1 type lists only
      // comment / system.
      kind: (COMMENT_KINDS.includes(String(row.kind))
        ? row.kind
        : 'comment') as CommentV2['kind'],
      parentId: str(row.parentId),
      rootId: str(row.rootId) ?? id,
      sourceRunId: str(row.sourceRunId),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      reactions: reactions.get(id) ?? [],
      resolvedAt: isoOrNull(row.resolvedAt),
      resolvedById: str(row.resolvedById),
      resolvedByName: str(row.resolvedById)
        ? (userNames.get(str(row.resolvedById) ?? '') ?? null)
        : null,
      context: fromJson<PmResolvedContext>(row.context) ?? null,
      via: row.via === 'pm' ? 'pm' : null,
    };
  });
}

async function create(
  deps: CommentDeps,
  actor: Actor,
  issueIdOrKey: string,
  input: CreateCommentRequest,
  options: CommentCreateOptions = {},
): Promise<CreateCommentResponse> {
  let content = typeof input?.content === 'string' ? input.content : '';
  if (content.trim() === '')
    throw invalid('INVALID_COMMENT', 'content is required.');
  if (content.length > MAX_CONTENT_LENGTH)
    throw invalid('INVALID_COMMENT', 'content is too long.');

  return deps.tx.run(async (tx) => {
    await requireActorCapability(
      tx.conn,
      actor,
      'comment.create',
      issueIdOrKey,
    );
    let issue;
    if (actor.type === 'user') {
      // Members see and comment on visible issues; mentioning an agent needs access to it (contract §B). The project
      // manager's comments in a member's name (NP-183) never invoke an agent, so their mentions are plain text.
      const viewer = await viewerOf(tx.conn, actor);
      issue = await requireVisibleIssue(tx.conn, viewer, issueIdOrKey);
      requireEditIssues(viewer);
      if (!isNote(content) && actor.via !== 'pm')
        for (const agentId of parseMentions(content))
          await requireInvokeAgent(tx.conn, viewer.userId, agentId);
    } else {
      issue = await findIssue(tx.conn, issueIdOrKey);
      // A project manager's retrospective (iteration 4 §C) is always an internal note, whether or not the model
      // remembered the `/note` prefix: it must never notify anyone or wake an executor.
      if (
        actor.runId &&
        !isNote(content) &&
        (await isRetrospectiveRun(tx, actor.runId))
      )
        content = `/note\n${content}`;
    }
    if (!issue) throw notFound('Issue');
    const message = await deps.conversations?.().onMessage(tx, {
      issue,
      actor,
      content,
      context: (input as CreateCommentRequestPm | undefined)?.context,
    });
    if (message) issue = message.issue;
    let parent: CommentV5 | null = null;
    if (input.parentId) {
      const parentRow = await tx.conn.query
        .selectFrom('comments')
        .selectAll()
        .where('id', '=', input.parentId)
        .executeTakeFirst();
      if (!parentRow || parentRow.issueId !== issue.id) {
        throw invalid(
          'INVALID_PARENT',
          'parentId must be a comment on the same issue.',
        );
      }
      parent = (await mapComments(tx.conn, deps.users, [parentRow]))[0] ?? null;
    }
    const id = deps.ids.next();
    const timestamp = now();
    const row = {
      id,
      issueId: issue.id,
      authorType: actor.type,
      authorId: actor.id,
      content,
      kind: options.kind ?? 'comment',
      parentId: parent?.id ?? null,
      // The thread root is the parent's root: resolving it once at insert makes "topmost parent" a column read.
      rootId: parent?.rootId ?? id,
      sourceRunId: actor.runId ?? null,
      context: message?.context ? toJson(message.context) : null,
      via: actor.via === 'pm' ? 'pm' : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await tx.conn.query.insertInto('comments').values(row).execute();
    await tx.conn.query
      .updateTable('issues')
      .set({ lastActivityAt: timestamp })
      .where('id', '=', issue.id)
      .execute();
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action: 'comment_added',
      details: { commentId: id, parentId: row.parentId },
    });
    const comment = (await mapComments(tx.conn, deps.users, [row]))[0];
    const triggered =
      options.trigger === false
        ? []
        : await deps
            .triggers()
            .onCommentCreated(tx, { comment, issue, parent, actor });
    tx.emit({ type: 'issue.changed', issueId: issue.id });
    tx.emit({
      type: 'comment.created',
      issueId: issue.id,
      commentId: id,
      actor: { type: actor.type, id: actor.id },
      mentionedUserIds: parseUserMentions(content),
    });
    return { comment, triggered };
  }, options.outer);
}

async function listForAgent(
  deps: CommentDeps,
  issueIdOrKey: string,
  query: AgentCommentQuery,
): Promise<CommentForAgentV2[]> {
  const conn = deps.tx.read();
  const issue = await findIssue(conn, issueIdOrKey);
  if (!issue) throw notFound('Issue');
  let select = conn.query
    .selectFrom('comments')
    .selectAll()
    .where('issueId', '=', issue.id);
  const since = query.since ? toDate(query.since) : null;
  if (query.since && !since)
    throw invalid('INVALID_SINCE', 'since must be an ISO 8601 timestamp.');
  if (since) select = select.where('createdAt', '>', since);
  if (query.thread) select = select.where('rootId', '=', query.thread);
  const rows = await select
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  let comments = await mapComments(conn, deps.users, rows);
  const resolvedRoots = await resolvedThreadRoots(
    conn,
    comments.map((comment) => comment.rootId),
  );
  if (query.excludeResolved)
    comments = comments.filter(
      (comment) =>
        !resolvedRoots.has(comment.rootId) || comment.rootId === query.thread,
    );
  if (query.rootsOnly)
    comments = comments.filter((comment) => comment.parentId === null);
  if (query.tail && query.tail > 0) comments = comments.slice(-query.tail);
  return comments.map((comment) => ({
    id: comment.id,
    authorType: comment.authorType,
    authorName: comment.authorName,
    content: comment.content,
    parentId: comment.parentId,
    rootId: comment.rootId,
    createdAt: comment.createdAt,
    resolved: resolvedRoots.has(comment.rootId),
  }));
}

/** Thread roots among `rootIds` that are resolved. */
export async function resolvedThreadRoots(
  conn: Conn,
  rootIds: readonly string[],
): Promise<Set<string>> {
  const ids = unique(rootIds);
  if (ids.length === 0) return new Set();
  const rows = await conn.query
    .selectFrom('comments')
    .select('id')
    .where('id', 'in', ids)
    .where('resolvedAt', 'is not', null)
    .execute();
  return new Set(rows.map((row) => str(row.id) ?? ''));
}

async function commentListForIssue(
  deps: CommentDeps,
  ...[conn, issueId]: Parameters<CommentService['listForIssue']>
) {
  const rows = await conn.query
    .selectFrom('comments')
    .selectAll()
    .where('issueId', '=', issueId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return mapComments(conn, deps.users, rows);
}

async function commentPageForIssue(
  deps: CommentDeps,
  ...[conn, issueId, cursor, limit]: Parameters<CommentService['pageForIssue']>
): Promise<CommentPage> {
  let query = conn.query
    .selectFrom('comments')
    .selectAll()
    .where('issueId', '=', issueId);
  if (cursor) {
    const key = decodeCursor(cursor);
    query = query.where((eb) =>
      eb.or([
        eb('createdAt', '<', key.at),
        eb.and([eb('createdAt', '=', key.at), eb('id', '<', key.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();
  const data = await mapComments(
    conn,
    deps.users,
    rows.slice(0, limit).reverse(),
  );
  const oldest = data[0];
  return {
    data,
    nextCursor:
      rows.length > limit && oldest
        ? encodeCursor(oldest.createdAt, oldest.id)
        : null,
  };
}

export function createCommentService(deps: CommentDeps): CommentService {
  return {
    create: (...args: Parameters<CommentService['create']>) =>
      create(deps, ...args),
    listForAgent: (...args: Parameters<CommentService['listForAgent']>) =>
      listForAgent(deps, ...args),
    listForIssue: (...args) => commentListForIssue(deps, ...args),
    pageForIssue: (...args) => commentPageForIssue(deps, ...args),
  };
}

async function isRetrospectiveRun(tx: Tx, runId: string): Promise<boolean> {
  const row = await tx.conn.query
    .selectFrom('runTriggers')
    .select('id')
    .where('runId', '=', runId)
    .where('type', '=', 'retrospective')
    .executeTakeFirst();
  return row !== undefined;
}
