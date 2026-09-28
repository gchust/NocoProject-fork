/**
 * Agent mentions in comment markdown: `[@Name](mention://agent/<id>)` (protocol §2).
 *
 * Pure text helpers for the composer's `@` picker and the trigger preview. The composer works on a plain textarea,
 * so a mention is inserted as its markdown link and rendered as a chip only when the comment is displayed.
 */

export const MENTION_PATTERN =
  /\[@([^\]]*)\]\(mention:\/\/agent\/([^)\s]+)\)/gu;

/** Every agent id mentioned in the text, in first-appearance order, without duplicates. */
export function extractMentionedAgentIds(content: string): string[] {
  const ids: string[] = [];
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const agentId = decodeURIComponent(match[2]);
    if (!ids.includes(agentId)) ids.push(agentId);
  }
  return ids;
}

export interface MentionQuery {
  /** Index of the `@` that opened the query. */
  readonly start: number;
  /** Text typed after the `@`, up to the caret. */
  readonly query: string;
}

/**
 * The `@query` the caret is currently completing, or null. An `@` opens a query only at the start of the text or
 * after whitespace or an opening bracket, so an e-mail address does not open the picker; whitespace ends it.
 */
export function findMentionQuery(
  text: string,
  caret: number,
): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const preceding = at === 0 ? '' : before[at - 1];
  if (preceding !== '' && !/[\s([]/u.test(preceding)) return null;
  const query = before.slice(at + 1);
  if (/\s/u.test(query) || query.length > 40) return null;
  return { start: at, query };
}

/** Escapes characters that would end the link label early. */
function mentionLabel(name: string): string {
  return name.replace(/[[\]]/gu, '');
}

export function mentionMarkdown(agent: {
  readonly id: string;
  readonly name: string;
}): string {
  return `[@${mentionLabel(agent.name)}](mention://agent/${encodeURIComponent(agent.id)})`;
}

/**
 * Replaces the `@query` ending at the caret with the agent's mention link followed by a space, and returns the new
 * text with the caret placed after that space.
 */
export function insertMention(
  text: string,
  caret: number,
  agent: { readonly id: string; readonly name: string },
): { readonly text: string; readonly caret: number } {
  const active = findMentionQuery(text, caret);
  const start = active?.start ?? caret;
  const link = `${mentionMarkdown(agent)} `;
  const after = text.slice(caret);
  return {
    text: text.slice(0, start) + link + after.replace(/^ /u, ''),
    caret: start + link.length,
  };
}

/** Parses `mention://agent/<id>` into the agent id, or null for any other URL. */
export function parseMentionHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = /^mention:\/\/agent\/([^/?#\s]+)$/u.exec(href);
  return match ? decodeURIComponent(match[1]) : null;
}
