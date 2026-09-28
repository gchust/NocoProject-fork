/**
 * Reactions and thread resolution (docs/phase1/iteration-2-contract.md §F). Any member who can see the comment's
 * issue may react (fixed emoji set, else 400 `INVALID_EMOJI`) and resolve / unresolve a thread (root comments only,
 * else 400 `NOT_THREAD_ROOT`). Resolving records `thread_resolved` / `thread_unresolved`; everything pushes
 * `np:issues` through `issue.changed`. Adding a reaction twice and removing one that is not there are no-ops.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import { requireVisibleIssue, viewerOf } from '../shared/authz.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { isUniqueViolation, now, str } from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type { CommentReaction, ReactionEmoji } from '../shared/protocol.js';
import { REACTION_EMOJIS } from '../shared/protocol.js';
import { reactionsFor } from './comment.service.js';

export interface ThreadState {
  readonly commentId: string;
  readonly resolvedAt: string | null;
  readonly resolvedById: string | null;
}

export interface ReactionService {
  add(
    actor: Actor,
    commentId: string,
    emoji: unknown,
  ): Promise<CommentReaction[]>;
  remove(
    actor: Actor,
    commentId: string,
    emoji: string,
  ): Promise<CommentReaction[]>;
  resolve(
    actor: Actor,
    commentId: string,
    resolved: boolean,
  ): Promise<ThreadState>;
}

export interface ReactionDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly activity: ActivityRecorder;
}

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly unknown[]).includes(value);
}

function requireEmoji(value: unknown): ReactionEmoji {
  if (!isReactionEmoji(value))
    throw invalid(
      'INVALID_EMOJI',
      `emoji must be one of ${REACTION_EMOJIS.join(' ')}.`,
    );
  return value;
}

/** The comment, after checking the caller can see its issue (404 otherwise). */
async function visibleComment(
  tx: Tx,
  actor: Actor,
  commentId: string,
): Promise<Record<string, unknown>> {
  const row = await tx.conn.query
    .selectFrom('comments')
    .selectAll()
    .where('id', '=', commentId)
    .executeTakeFirst();
  if (!row) throw notFound('Comment');
  try {
    await requireVisibleIssue(
      tx.conn,
      await viewerOf(tx.conn, actor),
      str(row.issueId) ?? '',
    );
  } catch {
    throw notFound('Comment');
  }
  return row;
}

export function createReactionService(deps: ReactionDeps): ReactionService {
  return {
    async add(actor, commentId, value) {
      const emoji = requireEmoji(value);
      return deps.tx.run(async (tx) => {
        const comment = await visibleComment(tx, actor, commentId);
        const timestamp = now();
        try {
          await tx.conn.transaction(async (inner) => {
            await inner.query
              .insertInto('commentReactions')
              .values({
                id: deps.ids.next(),
                commentId,
                userId: actor.id,
                emoji,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .execute();
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
        tx.emit({ type: 'issue.changed', issueId: str(comment.issueId) ?? '' });
        return (await reactionsFor(tx.conn, [commentId])).get(commentId) ?? [];
      });
    },
    async remove(actor, commentId, value) {
      const emoji = requireEmoji(value);
      return deps.tx.run(async (tx) => {
        const comment = await visibleComment(tx, actor, commentId);
        await tx.conn.query
          .deleteFrom('commentReactions')
          .where('commentId', '=', commentId)
          .where('userId', '=', actor.id)
          .where('emoji', '=', emoji)
          .execute();
        tx.emit({ type: 'issue.changed', issueId: str(comment.issueId) ?? '' });
        return (await reactionsFor(tx.conn, [commentId])).get(commentId) ?? [];
      });
    },
    async resolve(actor, commentId, resolved) {
      return deps.tx.run(async (tx) => {
        const comment = await visibleComment(tx, actor, commentId);
        if (str(comment.parentId))
          throw invalid(
            'NOT_THREAD_ROOT',
            'Only a thread root can be resolved.',
          );
        const issueId = str(comment.issueId) ?? '';
        const already =
          comment.resolvedAt !== null && comment.resolvedAt !== undefined;
        if (already !== resolved) {
          const timestamp = now();
          await tx.conn.query
            .updateTable('comments')
            .set({
              resolvedAt: resolved ? timestamp : null,
              resolvedById: resolved ? actor.id : null,
              updatedAt: timestamp,
            })
            .where('id', '=', commentId)
            .execute();
          await deps.activity.record(tx.conn, {
            issueId,
            actor,
            action: resolved ? 'thread_resolved' : 'thread_unresolved',
            details: { commentId },
          });
          tx.emit({ type: 'issue.changed', issueId });
        }
        const row = await tx.conn.query
          .selectFrom('comments')
          .select(['resolvedAt', 'resolvedById'])
          .where('id', '=', commentId)
          .executeTakeFirst();
        return {
          commentId,
          resolvedAt: row?.resolvedAt
            ? new Date(row.resolvedAt as string).toISOString()
            : null,
          resolvedById: str(row?.resolvedById),
        };
      });
    },
  };
}
