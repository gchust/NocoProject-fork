import { toolSummary } from '../../issues/detail/tool-summary.js';
import type { CommentThread, IssueComment, RunEvent } from '../../types.js';

/**
 * A project manager conversation as pure data (NP-185): the messages in order with their kinds, the turn in progress
 * folded into one line of work plus the streamed reply, the references a message makes, and the attachment links
 * appended to a message.
 */

export type PmMessage =
  | { readonly kind: 'user' | 'agent'; readonly comment: IssueComment }
  | { readonly kind: 'system'; readonly comment: IssueComment }
  | {
      readonly kind: 'plan';
      readonly comment: IssueComment;
      readonly planId: string;
    }
  | {
      readonly kind: 'planResult';
      readonly comment: IssueComment;
      readonly planId: string | null;
    };

function planIdOf(comment: IssueComment): string | null {
  const value = comment.details?.planId;
  return typeof value === 'string' && value ? value : null;
}

/** Every comment of the conversation, oldest first, as the message it renders as. */
export function pmMessages(threads: readonly CommentThread[]): PmMessage[] {
  return threads
    .flatMap((thread) => [thread.root, ...thread.replies])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((comment): PmMessage => {
      if (comment.kind === 'plan') {
        const planId = planIdOf(comment);
        if (planId) return { kind: 'plan', comment, planId };
      }
      if (comment.kind === 'plan_result') {
        return { kind: 'planResult', comment, planId: planIdOf(comment) };
      }
      if (comment.kind === 'system' || comment.authorType === 'system') {
        return { kind: 'system', comment };
      }
      return {
        kind: comment.authorType === 'agent' ? 'agent' : 'user',
        comment,
      };
    });
}

export interface LiveTurnView {
  /** The reply streamed so far: the turn's text events in order. */
  readonly reply: string;
  /** Thinking, tool calls and their results: what the folded line expands to. */
  readonly steps: readonly RunEvent[];
  /** What the folded line says: the last tool call's summary, or null while only thinking. */
  readonly current: string | null;
  readonly lastTool: string | null;
}

export function liveTurnView(events: readonly RunEvent[]): LiveTurnView {
  const texts: string[] = [];
  const steps: RunEvent[] = [];
  let current: string | null = null;
  let lastTool: string | null = null;
  for (const event of events) {
    if (event.type === 'text') {
      if (event.content) texts.push(event.content);
      continue;
    }
    steps.push(event);
    if (event.type === 'toolUse') {
      lastTool = event.tool ?? null;
      current = toolSummary(event.input) ?? event.tool ?? null;
    }
  }
  return { reply: texts.join('\n\n'), steps, current, lastTool };
}

export type PmReference =
  | { readonly type: 'issue'; readonly key: string; readonly value: string }
  | { readonly type: 'project'; readonly key: string; readonly value: string }
  | {
      readonly type: 'knowledgeDoc';
      readonly key: string;
      readonly value: string;
    };

export const MAX_REFERENCES = 5;

const IDENTIFIER = /(?<![\w/-])([A-Z][A-Z0-9]{1,9}-\d{1,7})(?![\w-])/gu;
const LINK =
  /(?:^|[\s(<"'])(?:https?:\/\/[^\s/]+)?(?:\/[\w-]+)*\/(issues|projects|knowledge)\/([\w-]+)(?=[\s)>"'#?]|$)/gmu;

/**
 * The tasks, projects and knowledge documents a message mentions — issue identifiers (`NP-12`) and in-app links —
 * in order of first mention, each once, at most five. Code spans and fenced blocks are skipped.
 */
export function referencesIn(content: string): PmReference[] {
  const text = content.replace(/```[\s\S]*?```/gu, ' ').replace(/`[^`]*`/gu, ' ');
  const found: { index: number; reference: PmReference }[] = [];
  for (const match of text.matchAll(LINK)) {
    const segment = match[1];
    const value = match[2];
    if (value === 'new') continue;
    const type =
      segment === 'issues'
        ? 'issue'
        : segment === 'projects'
          ? 'project'
          : 'knowledgeDoc';
    found.push({
      index: match.index,
      reference: { type, key: `${type}:${value}`, value },
    });
  }
  for (const match of text.matchAll(IDENTIFIER)) {
    const value = match[1];
    found.push({
      index: match.index,
      reference: { type: 'issue', key: `issue:${value}`, value },
    });
  }
  const seen = new Set<string>();
  const references: PmReference[] = [];
  for (const { reference } of found.sort((a, b) => a.index - b.index)) {
    if (seen.has(reference.key)) continue;
    seen.add(reference.key);
    references.push(reference);
    if (references.length >= MAX_REFERENCES) break;
  }
  return references;
}

/** The message text with the files attached to it listed at the end, so the agent knows which message they belong to. */
export function withAttachmentLinks(
  content: string,
  files: readonly { readonly filename: string; readonly contentUrl: string }[],
): string {
  if (files.length === 0) return content;
  const links = files
    .map((file) => `- [${file.filename.replace(/[[\]]/gu, '')}](${file.contentUrl})`)
    .join('\n');
  return content.trim() ? `${content.trim()}\n\n${links}` : links;
}
