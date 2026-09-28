import { extractMentionedAgentIds } from './mentions.js';
import type { ActorType, ExecutorRef } from '../types.js';

/**
 * Which agents a comment will trigger once posted — the browser's reading of the Phase 0 trigger rules
 * (protocol §2). The server's trigger module stays authoritative; this only previews its decision under the composer.
 *
 * In order:
 * 1. A comment starting with `/note` triggers nothing.
 * 2. Explicit `[@Name](mention://agent/<id>)` mentions trigger each mentioned agent once.
 * 3. A reply (no mentions) to an agent's comment triggers that agent.
 * 4. A top-level comment (no mentions) triggers the issue's executor when the executor is an agent.
 * 5. Otherwise nothing — including a reply to a person's comment.
 */

export type TriggerReason = 'note' | 'mention' | 'reply' | 'executor' | 'none';

export interface TriggerPreview {
  readonly reason: TriggerReason;
  /** Agents that will be triggered, without duplicates; empty for `note` and `none`. */
  readonly agentIds: readonly string[];
}

export interface TriggerPreviewInput {
  readonly content: string;
  /** The comment being replied to, or null for a top-level comment. */
  readonly replyTo: {
    readonly authorType: ActorType;
    readonly authorId: string | null;
  } | null;
  readonly executor: ExecutorRef;
}

export function isNoteComment(content: string): boolean {
  return /^\/note(?:\s|$)/u.test(content.trimStart());
}

export function computeTriggerPreview({
  content,
  replyTo,
  executor,
}: TriggerPreviewInput): TriggerPreview {
  if (isNoteComment(content)) return { reason: 'note', agentIds: [] };

  const mentioned = extractMentionedAgentIds(content);
  if (mentioned.length > 0) return { reason: 'mention', agentIds: mentioned };

  if (replyTo) {
    if (replyTo.authorType === 'agent' && replyTo.authorId) {
      return { reason: 'reply', agentIds: [replyTo.authorId] };
    }
    return { reason: 'none', agentIds: [] };
  }

  if (executor.type === 'agent' && executor.id) {
    return { reason: 'executor', agentIds: [executor.id] };
  }
  return { reason: 'none', agentIds: [] };
}
