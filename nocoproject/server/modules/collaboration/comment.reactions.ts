import type { Conn } from '../shared/db.js';
import { str, unique } from '../shared/db.js';
import type { CommentReaction } from '../shared/protocol.js';
import { REACTION_EMOJIS } from '../shared/protocol.js';

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
