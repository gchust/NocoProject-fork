import type {
  CommentReaction,
  CommentThread,
  IssueComment,
  IssueDetail,
} from '../../types.js';

/**
 * Comment reactions (iteration 2 §F): each person toggles their own emoji from the fixed set. Pure helpers for the
 * toggle decision and the optimistic cache update.
 */

export function hasReacted(
  reactions: readonly CommentReaction[] | undefined,
  emoji: string,
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  return (
    reactions?.some(
      (reaction) =>
        reaction.emoji === emoji && reaction.userIds.includes(userId),
    ) ?? false
  );
}

/** The reactions after `userId` toggles `emoji`: added with count + 1, or removed (and dropped at zero). */
export function toggleReaction(
  reactions: readonly CommentReaction[] | undefined,
  emoji: string,
  userId: string,
): CommentReaction[] {
  const list = [...(reactions ?? [])];
  const index = list.findIndex((reaction) => reaction.emoji === emoji);
  if (index < 0) return [...list, { emoji, count: 1, userIds: [userId] }];
  const current = list[index];
  if (current.userIds.includes(userId)) {
    const userIds = current.userIds.filter((id) => id !== userId);
    if (userIds.length === 0) return list.filter((_, at) => at !== index);
    list[index] = { emoji, count: Math.max(current.count - 1, 0), userIds };
    return list;
  }
  list[index] = {
    emoji,
    count: current.count + 1,
    userIds: [...current.userIds, userId],
  };
  return list;
}

function mapComment(
  comment: IssueComment,
  commentId: string,
  update: (comment: IssueComment) => IssueComment,
): IssueComment {
  return comment.id === commentId ? update(comment) : comment;
}

/** The detail with one comment replaced through `update`, wherever it sits in a thread. */
export function updateDetailComment(
  detail: IssueDetail,
  commentId: string,
  update: (comment: IssueComment) => IssueComment,
): IssueDetail {
  const threads = detail.threads.map((thread): CommentThread => ({
    root: mapComment(thread.root, commentId, update),
    replies: thread.replies.map((reply) =>
      mapComment(reply, commentId, update),
    ),
  }));
  return { ...detail, threads };
}

/** Reactions with at least one person, in the fixed order of the emoji set, unknown emoji last. */
export function visibleReactions(
  reactions: readonly CommentReaction[] | undefined,
  order: readonly string[],
): CommentReaction[] {
  const rank = (emoji: string): number => {
    const index = order.indexOf(emoji);
    return index < 0 ? order.length : index;
  };
  return (reactions ?? [])
    .filter((reaction) => reaction.count > 0)
    .sort((a, b) => rank(a.emoji) - rank(b.emoji));
}
