/**
 * Knowledge-base sections of the runtime brief (iteration 3 §I): the `kb` commands, `## Knowledge`
 * (the documents from the claim's `knowledge` index and how to read them) and `## Capture learnings`
 * (propose, never edit; at most 3 proposals per run). Pure string builders.
 */
import { type ClaimedRunV1, knowledgeOf } from '../run-context.js';

export type KnowledgeBriefInput = Pick<ClaimedRunV1, 'knowledge'>;

/** The per-run proposal limit the brief states. */
export const KB_PROPOSALS_PER_RUN = 3;

export function knowledgeCommands(): string[] {
  return [
    '- `nocoproject kb list --json` — list the knowledge documents you can read (see Knowledge)',
    '- `nocoproject kb get <slug> [--json]` — print a knowledge document’s Markdown',
    '- `nocoproject kb propose (--doc <slug> | --title "...") --content-file ./kb.md --reason "..." [--summary "..."] --json` — propose a knowledge change for a human to accept (see Capture learnings)',
  ];
}

/** `## Knowledge`: every document in the index (title, slug, summary) and the `kb get` usage. */
export function knowledgeSection(input: KnowledgeBriefInput): string[] {
  const docs = knowledgeOf(input);
  const lines = ['## Knowledge', ''];
  if (docs.length === 0) {
    lines.push(
      'No knowledge documents are available to this run yet. `nocoproject kb list --json` shows documents added after the run started.',
      '',
    );
    return lines;
  }
  lines.push(
    'Your team keeps conventions, pitfalls and decisions for this project (and system-wide) in the knowledge base. Humans maintain it, so trust it over guesses: read a document before you work in the area it covers.',
    '',
  );
  for (const doc of docs) {
    const scope = doc.projectId ? '' : ', system-wide';
    const summary = doc.summary.replace(/\s+/g, ' ').trim() || '(no summary)';
    const childHint = doc.childCount > 0 ? ` (${doc.childCount} sub-document${doc.childCount === 1 ? '' : 's'}: \`nocoproject kb list --parent ${doc.slug}\`)` : '';
    lines.push(`- **${doc.title}** (\`${doc.slug}\`${scope}) — ${summary}${childHint}`);
  }
  lines.push(
    '',
    'Read one with `nocoproject kb get <slug>` (prints its Markdown; `--json` adds the version and metadata). `nocoproject kb list --json` shows the current list.',
    '',
  );
  return lines;
}

/** `## Capture learnings`: before finishing, propose (never edit) up to 3 durable learnings. */
export function captureLearningsSection(): string[] {
  return [
    '## Capture learnings',
    '',
    'Before you finish the task, ask yourself whether you found something the next person or agent on this project should know: a convention, a pitfall, or a decision and why it was made. If so, propose it to the knowledge base:',
    '',
    '- Update an existing document: `nocoproject kb propose --doc <slug> --content-file ./kb.md --reason "..." --json`. The file holds the whole new content, so start from `nocoproject kb get <slug>` and edit that.',
    '- Add a new document: `nocoproject kb propose --title "..." [--slug <slug>] --content-file ./kb.md --reason "..." [--summary "..."] --json`.',
    '- `--reason` (at most 500 characters) says what you found and why it matters.',
    '- Do not edit knowledge documents directly, and do not write them into the repository instead. A proposal goes to the project lead, who accepts or rejects it; an accepted one becomes the next version.',
    `- Propose at most ${KB_PROPOSALS_PER_RUN} per run, and only durable, reusable knowledge, not a log of this task. If you learned nothing new, skip this.`,
    '- Each document takes one pending proposal per run; a second one is refused with `KNOWLEDGE_PROPOSAL_PENDING`, so put everything for that document into one proposal.',
  ];
}
