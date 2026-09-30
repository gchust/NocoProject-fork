/**
 * Knowledge-base sections of the runtime brief (iteration 3 §I): the `kb` commands, `## Knowledge`
 * (the documents from the claim's `knowledge` index and how to read them), `## Capture learnings`
 * (propose, never edit; at most 3 proposals per run) and `## User manual` (NP-179: keep the
 * `manual` subtree in step with user-visible changes). Pure string builders.
 */
import { type ClaimedRunV1, knowledgeOf } from '../run-context.js';

export type KnowledgeBriefInput = Pick<ClaimedRunV1, 'knowledge'>;

/** The per-run proposal limit the brief states. */
export const KB_PROPOSALS_PER_RUN = 3;

export function knowledgeCommands(): string[] {
  return [
    '- `nocoproject kb list --json` — list the knowledge documents you can read (see Knowledge)',
    '- `nocoproject kb get <slug> [--json]` — print a knowledge document’s Markdown',
    '- `nocoproject kb propose (--doc <slug> | --title "..." [--parent <slug|id>]) --content-file ./kb.md --reason "..." [--summary "..."] --json` — propose a knowledge change for a human to accept; a new document inherits its parent’s scope, or the run’s project without a parent',
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
    '- Add a new document: `nocoproject kb propose --title "..." [--slug <slug>] [--parent <slug|id>] --content-file ./kb.md --reason "..." [--summary "..."] --json`.',
    '- With `--parent`, a new document inherits the parent’s scope: system-level or this project. Without a parent it defaults to the run’s project (system-level for a projectless run). Parents must be visible to this run; system-level proposals still need a system-level knowledge decider.',
    '- `--reason` (at most 500 characters) says what you found and why it matters.',
    '- Do not edit knowledge documents directly, and do not write them into the repository instead. A proposal goes to the project lead, who accepts or rejects it; an accepted one becomes the next version.',
    `- Propose at most ${KB_PROPOSALS_PER_RUN} per run, and only durable, reusable knowledge, not a log of this task. If you learned nothing new, skip this.`,
    '- Each document takes one pending proposal per run; a second one is refused with `KNOWLEDGE_PROPOSAL_PENDING`, so put everything for that document into one proposal.',
  ];
}

/** NP-179: the root slug of the user manual; its pages are `manual-*`. */
export const MANUAL_ROOT_SLUG = 'manual';

/** The run can see the user manual (its root is in the knowledge index). */
export function hasUserManual(input: Partial<KnowledgeBriefInput>): boolean {
  return knowledgeOf({ knowledge: input.knowledge ?? [] }).some((doc) => doc.slug === MANUAL_ROOT_SLUG);
}

/** `## User manual`: a user-visible change proposes the affected `manual-*` pages; the delivery says which. */
export function userManualSection(input: KnowledgeBriefInput): string[] {
  if (!hasUserManual(input)) return [];
  return [
    '## User manual',
    '',
    `The knowledge base holds the NocoProject user manual (root \`${MANUAL_ROOT_SLUG}\`, pages \`manual-*\`). It is part of delivery: if your change alters what NocoProject users see or do (screens, flows, permissions, CLI commands), before you deliver:`,
    '',
    '1. Find the affected pages with `nocoproject kb list --tree` and read each with `nocoproject kb get <slug>`.',
    '2. Propose each updated page with `nocoproject kb propose --doc <slug> --content-file ./kb.md --reason "..." --json` (the whole page), and set `最后核对：YYYY-MM-DD` in its first line to today.',
    '3. End your delivery comment with one line: `手册：已更新 <slug>, <slug>`, or `手册：无影响` when nothing users see changed.',
  ];
}
