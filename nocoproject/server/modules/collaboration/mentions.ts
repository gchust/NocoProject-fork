/**
 * Comment markup understood by the trigger rules (protocol.md §2).
 *
 * - An agent mention is the Markdown link `[@Name](mention://agent/<id>)`. The name is display text only; the id
 *   decides who is mentioned.
 * - A member mention is `[@Name](mention://user/<userId>)` (iteration 1): it subscribes and notifies the member.
 * - A comment whose first non-blank characters are `/note` never triggers anything.
 */
const MENTION_PATTERN =
  /\[@[^\]\n]*\]\(mention:\/\/agent\/([A-Za-z0-9_-]+)\)/gu;
const USER_MENTION_PATTERN =
  /\[@[^\]\n]*\]\(mention:\/\/user\/([A-Za-z0-9_.@-]+)\)/gu;
const NOTE_PATTERN = /^\s*\/note(?:\s|$)/u;

/** Mentioned agent ids, deduplicated, in order of first appearance. */
export function parseMentions(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

/** Mentioned user ids, deduplicated, in order of first appearance. */
export function parseUserMentions(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(USER_MENTION_PATTERN)) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export function isNote(content: string): boolean {
  return NOTE_PATTERN.test(content);
}

/** Renders an agent mention in the canonical markup. */
export function mentionMarkup(agent: { id: string; name: string }): string {
  return `[@${agent.name.replace(/[[\]]/gu, '')}](mention://agent/${agent.id})`;
}
