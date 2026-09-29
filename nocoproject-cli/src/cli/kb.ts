/**
 * `nocoproject kb list | get | propose` (iteration 3 §I): read the knowledge base of the run's
 * project (plus system-level documents) and propose updates. Agents never edit documents
 * directly: a proposal goes to the project lead's inbox and becomes a new version once accepted.
 * Run-token mode.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { KnowledgeProposalBody } from '../api/client.js';
import type { KnowledgeDocSummary, KnowledgeProposal } from '../protocol.js';
import { KNOWLEDGE_REASON_MAX, KNOWLEDGE_SLUG_PATTERN, KNOWLEDGE_SUMMARY_MAX } from '../protocol.js';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt, runTokenContext } from './run-token.js';

export const KB_REASON_MAX = KNOWLEDGE_REASON_MAX;
export const KB_SUMMARY_MAX = KNOWLEDGE_SUMMARY_MAX;
const SLUG = KNOWLEDGE_SLUG_PATTERN;

export interface KbProposeOpts extends JsonOpt {
  doc?: string;
  title?: string;
  slug?: string;
  parent?: string;
  contentFile?: string;
  reason?: string;
  summary?: string;
}

function scopeOf(doc: Pick<KnowledgeDocSummary, 'projectId'>): string {
  return doc.projectId ? 'project' : 'system';
}

function describeDoc(doc: KnowledgeDocSummary): string[] {
  const version = typeof doc.version === 'number' ? `, v${doc.version}` : '';
  const lines = [`${doc.slug}  ${doc.title}  (${scopeOf(doc)}${version})`];
  const summary = doc.summary?.replace(/\s+/g, ' ').trim();
  if (summary) lines.push(`  ${summary}`);
  if (doc.matchExcerpt) lines.push(`  … ${doc.matchExcerpt.replace(/\s+/g, ' ').trim()}`);
  return lines;
}

export interface KbListOpts extends JsonOpt {
  q?: string;
  parent?: string;
  tree?: boolean;
}

/** A `KnowledgeDocSummary` with its direct children nested, for `kb list --tree` (NP-147 leaves the tree a client concern). */
export interface KnowledgeTreeNode extends KnowledgeDocSummary {
  readonly children: readonly KnowledgeTreeNode[];
}

interface MutableKnowledgeNode {
  readonly doc: KnowledgeDocSummary;
  readonly children: MutableKnowledgeNode[];
}

/** Nests the flat list by `parentId`; a document whose parent is missing from the list (e.g. archived) becomes a root. Siblings sort by `sortOrder`. */
export function buildKnowledgeForest(docs: readonly KnowledgeDocSummary[]): KnowledgeTreeNode[] {
  const nodes = new Map<string, MutableKnowledgeNode>();
  for (const doc of docs) nodes.set(doc.id, { doc, children: [] });
  const roots: MutableKnowledgeNode[] = [];
  for (const doc of docs) {
    const node = nodes.get(doc.id) as MutableKnowledgeNode;
    const parent = doc.parentId ? nodes.get(doc.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const toTree = (list: MutableKnowledgeNode[]): KnowledgeTreeNode[] =>
    [...list].sort((a, b) => a.doc.sortOrder - b.doc.sortOrder).map((n) => ({ ...n.doc, children: toTree(n.children) }));
  return toTree(roots);
}

function printTreeNode(node: KnowledgeTreeNode, depth: number): void {
  const indent = '  '.repeat(depth - 1);
  for (const line of describeDoc(node)) printLine(indent + line);
  for (const child of node.children) printTreeNode(child, depth + 1);
}

function readProposalContent(file: string | undefined): string {
  if (!file) throw new CliError('--content-file is required', EXIT.validation, 'CONTENT_REQUIRED');
  const path = resolve(file);
  if (!existsSync(path)) throw new CliError(`content file not found: ${path}`, EXIT.validation, 'FILE_NOT_FOUND');
  const content = readFileSync(path, 'utf8');
  if (!content.trim()) throw new CliError('proposal content is empty', EXIT.validation, 'EMPTY_CONTENT');
  return content;
}

/**
 * Validates the flags and builds the request body, except `docId`, which the caller resolves
 * from `--doc` (slug or id). Exactly one of `--doc` / `--title`; `--slug` only with `--title`.
 */
export function proposalBody(opts: KbProposeOpts): Omit<KnowledgeProposalBody, 'docId'> {
  const doc = opts.doc?.trim();
  const title = opts.title?.trim();
  if (Boolean(doc) === Boolean(title)) throw new CliError('pass exactly one of --doc <slug|id> or --title <title>', EXIT.validation, 'INVALID_ARGUMENTS');
  if (doc && opts.slug !== undefined) throw new CliError('--slug only applies to a new document (--title)', EXIT.validation, 'INVALID_ARGUMENTS');
  if (doc && opts.parent !== undefined) throw new CliError('--parent only applies to a new document (--title)', EXIT.validation, 'INVALID_ARGUMENTS');
  const slug = opts.slug?.trim();
  if (slug !== undefined && !SLUG.test(slug)) throw new CliError(`invalid slug "${slug}": use 1-64 lower-case letters, digits and "-", not starting with "-"`, EXIT.validation, 'INVALID_SLUG');
  const parent = opts.parent?.trim();
  const reason = opts.reason?.trim();
  if (!reason) throw new CliError('--reason is required: say why the knowledge base should change', EXIT.validation, 'REASON_REQUIRED');
  if (reason.length > KB_REASON_MAX) throw new CliError(`--reason is longer than ${KB_REASON_MAX} characters`, EXIT.validation, 'REASON_TOO_LONG');
  const summary = opts.summary?.trim();
  if (summary && summary.length > KB_SUMMARY_MAX) throw new CliError(`--summary is longer than ${KB_SUMMARY_MAX} characters`, EXIT.validation, 'SUMMARY_TOO_LONG');
  const content = readProposalContent(opts.contentFile);
  return {
    ...(title ? { title } : {}),
    ...(slug ? { slug } : {}),
    ...(parent ? { parentId: parent } : {}),
    ...(summary ? { summary } : {}),
    content,
    reason,
  };
}

function describeProposal(p: Partial<KnowledgeProposal>, target: string): string {
  return `proposed ${target} (proposal ${p.id ?? '?'}, ${p.status ?? 'pending'}); the project lead decides whether to apply it`;
}

export function registerKbCommands(program: Command): void {
  const kb = program.command('kb').description('Knowledge base of the current agent run’s project (run-token mode)');

  kb.command('list')
    .description('List the knowledge documents (project and system level; no content)')
    .option('--q <text>', 'search the title, slug, summary and content (case-insensitive)')
    .option('--parent <doc>', 'list only the direct children of this document (slug or id)')
    .option('--tree', 'print the whole tree (title, slug, summary), indented by depth')
    .option('--json', 'JSON output')
    .action(
      action(async (opts: KbListOpts) => {
        if (opts.parent && opts.tree) throw new CliError('pass at most one of --parent or --tree', EXIT.validation, 'INVALID_ARGUMENTS');
        if (opts.tree && opts.q) throw new CliError('--tree cannot be combined with --q', EXIT.validation, 'INVALID_ARGUMENTS');
        const ctx = runTokenContext();
        const q = opts.q?.trim() || undefined;
        if (opts.tree) {
          const forest = buildKnowledgeForest((await ctx.api.knowledgeList()) ?? []);
          if (opts.json) return printJson(forest);
          if (forest.length === 0) return printLine('(no knowledge documents)');
          for (const node of forest) printTreeNode(node, 1);
          return;
        }
        if (opts.parent) {
          const parentDoc = await ctx.api.knowledgeDoc(opts.parent.trim());
          const data = ((await ctx.api.knowledgeList(q)) ?? []).filter((d) => d.parentId === parentDoc.id);
          if (opts.json) return printJson(data);
          if (data.length === 0) return printLine(`(${parentDoc.slug} has no child documents)`);
          for (const doc of data) for (const line of describeDoc(doc)) printLine(line);
          return;
        }
        const data = (await ctx.api.knowledgeList(q)) ?? [];
        if (opts.json) return printJson(data);
        if (data.length === 0) return printLine('(no knowledge documents)');
        for (const doc of data) for (const line of describeDoc(doc)) printLine(line);
      }),
    );

  kb.command('get <doc>')
    .description('Print a knowledge document’s Markdown content (by slug or id)')
    .option('--json', 'JSON output (the whole document)')
    .action(
      action(async (ref: string, opts: JsonOpt) => {
        const doc = await runTokenContext().api.knowledgeDoc(ref.trim());
        if (opts.json) return printJson(doc);
        const content = doc.content ?? '';
        process.stdout.write(content.endsWith('\n') || content === '' ? content : `${content}\n`);
      }),
    );

  kb.command('propose')
    .description('Propose a change to a knowledge document, or a new document; a human decides')
    .option('--doc <doc>', 'the document to update (slug or id)')
    .option('--title <title>', 'title of a new document')
    .option('--slug <slug>', 'slug of the new document (with --title; the server derives one otherwise)')
    .option('--parent <doc>', 'the parent document of the new document (slug or id, with --title; omitted = root)')
    .option('--content-file <path>', 'the full proposed Markdown content')
    .option('--reason <text>', `why it should change (at most ${KB_REASON_MAX} characters)`)
    .option('--summary <text>', `one-line summary of the document (at most ${KB_SUMMARY_MAX} characters)`)
    .option('--json', 'JSON output')
    .action(
      action(async (opts: KbProposeOpts) => {
        const body = proposalBody(opts);
        const ctx = runTokenContext();
        let target = `new document "${body.title ?? ''}"`;
        let docId: string | undefined;
        if (opts.doc) {
          const doc = await ctx.api.knowledgeDoc(opts.doc.trim());
          docId = doc.id;
          target = `an update to ${doc.slug ?? opts.doc}`;
        }
        const proposal = await ctx.api.proposeKnowledge(docId ? { docId, ...body } : body);
        if (opts.json) printJson(proposal);
        else printLine(describeProposal(proposal ?? {}, target));
      }),
    );
}
