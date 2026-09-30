/**
 * Agent-facing commands (run-token mode): issue get / comment list / comment add / status,
 * plus the Phase 1 sub-issue commands registered from ./subissue.ts, the Phase 2 stage
 * checklist command from ./checklist.ts and the NP-111 attachment commands from ./attachment.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import type { AgentAttachmentInfo, CommentForAgent, IssueForAgent } from '../protocol.js';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt, resolveIssueId, runTokenContext } from './run-token.js';
import { registerAttachmentCommands } from './attachment.js';
import { registerChecklistCommand } from './checklist.js';
import { registerSubIssueCommands } from './subissue.js';

export { resolveIssueId, runTokenContext, type RunTokenContext } from './run-token.js';

function printIssue(issue: IssueForAgent): void {
  printLine(`${issue.identifier || issue.id}  ${issue.title}`);
  printLine(`status: ${issue.statusKey}   priority: ${issue.priority}   owner: ${issue.ownerName}`);
  printLine(`executor: ${issue.executor.type}${issue.executor.name ? ` (${issue.executor.name})` : ''}`);
  printLine();
  printLine(issue.description || '(no description)');
  const attachments = (issue as IssueForAgent & { attachments?: readonly AgentAttachmentInfo[] }).attachments ?? [];
  if (attachments.length > 0) {
    printLine();
    printLine(`attachments (${attachments.length}; save them with \`nocoproject issue attachment download ${issue.identifier || issue.id}\`):`);
    for (const file of attachments) printLine(`  ${file.filename}  (${file.mimeType})`);
  }
}

function printComments(comments: readonly CommentForAgent[]): void {
  if (comments.length === 0) return printLine('(no comments)');
  for (const c of comments) {
    const reply = c.parentId ? ` ↳ reply in thread ${c.rootId}` : ` (thread root)`;
    const resolved = (c as CommentForAgent & { resolved?: boolean }).resolved ? ' [resolved]' : '';
    printLine(`--- [${c.id}] ${c.authorName} (${c.authorType}) ${c.createdAt}${reply}${resolved}`);
    printLine(c.content);
  }
}

const CommentAddInput = z
  .object({
    content: z.string().optional(),
    contentFile: z.string().optional(),
    parent: z.string().min(1).optional(),
  })
  .refine((v) => (v.content === undefined) !== (v.contentFile === undefined), {
    message: 'pass exactly one of --content or --content-file',
  });

function readContent(opts: { content?: string; contentFile?: string }): string {
  let content = opts.content;
  if (opts.contentFile !== undefined) {
    const path = resolve(opts.contentFile);
    if (!existsSync(path)) throw new CliError(`content file not found: ${path}`, EXIT.validation, 'FILE_NOT_FOUND');
    content = readFileSync(path, 'utf8');
  }
  if (!content || !content.trim()) throw new CliError('content is empty', EXIT.validation, 'EMPTY_CONTENT');
  return content;
}

export function registerIssueCommands(program: Command): void {
  const issue = program.command('issue').description('Read and update the issue of the current agent run (run-token mode)');

  issue
    .command('get [issue]')
    .description('Show an issue (defaults to the run’s issue)')
    .option('--json', 'JSON output')
    .action(
      action(async (arg: string | undefined, opts: JsonOpt) => {
        const ctx = runTokenContext();
        const data = await ctx.api.issue(await resolveIssueId(arg, ctx));
        if (opts.json) printJson(data);
        else printIssue(data);
      }),
    );

  const comment = issue.command('comment').description('Issue comments');
  comment
    .command('list [issue]')
    .description('List comments')
    .option('--since <iso>', 'only comments created after this time')
    .option('--thread <rootId>', 'only one thread')
    .option('--tail <n>', 'only the last n comments', (v) => z.coerce.number().int().positive().parse(v))
    .option('--roots-only', 'only thread roots')
    .option('--json', 'JSON output')
    .action(
      action(async (arg: string | undefined, opts: JsonOpt & { since?: string; thread?: string; tail?: number; rootsOnly?: boolean }) => {
        const ctx = runTokenContext();
        const data = await ctx.api.comments(await resolveIssueId(arg, ctx), opts);
        if (opts.json) printJson(data);
        else printComments(data ?? []);
      }),
    );
  comment
    .command('add [issue]')
    .description('Post a comment as the agent')
    .option('--content-file <path>', 'read the Markdown body from a file (preferred)')
    .option('--content <text>', 'inline Markdown body')
    .option('--parent <commentId>', 'reply inside this thread')
    .option('--json', 'JSON output')
    .action(
      action(async (arg: string | undefined, raw: JsonOpt & { content?: string; contentFile?: string; parent?: string }) => {
        const opts = CommentAddInput.parse(raw);
        const content = readContent(opts);
        const ctx = runTokenContext();
        const data = await ctx.api.addComment(await resolveIssueId(arg, ctx), content, opts.parent);
        if (raw.json) printJson(data);
        else printLine('comment posted');
      }),
    );

  issue
    .command('status <issueOrStatus> [statusKey]')
    .description('Change the status: `status <statusKey>` (run’s issue) or `status <issue> <statusKey>`; an approval gate answers "approval pending" (exit 0)')
    .option('--json', 'JSON output')
    .action(
      action(async (first: string, second: string | undefined, opts: JsonOpt) => {
        const ctx = runTokenContext();
        const [arg, key] = second === undefined ? [undefined, first] : [first, second];
        const statusKey = z.string().regex(/^[a-z][a-z0-9_]*$/, 'invalid status key').parse(key);
        const result = await ctx.api.setStatus(await resolveIssueId(arg, ctx), statusKey);
        if (result.kind === 'pending') {
          // 202: an approval gate holds the change (iteration 2 §D). Not an error: exit 0.
          if (opts.json) printJson(result.data);
          else printLine(`approval pending (request ${result.data?.pendingApproval?.id ?? 'unknown'})`);
          return;
        }
        if (opts.json) printJson(result.data ?? { ok: true, statusKey });
        else printLine(`status set to ${statusKey}`);
      }),
    );

  issue
    .command('design-proposal [issue]')
    .description('Submit the design proposal of a design-first issue (a `proposal` comment); then set `proposal_review`')
    .option('--content-file <path>', 'the whole proposal in Markdown')
    .option('--json', 'JSON output')
    .action(
      action(async (arg: string | undefined, opts: JsonOpt & { contentFile?: string }) => {
        if (!opts.contentFile) throw new CliError('--content-file is required', EXIT.validation, 'CONTENT_REQUIRED');
        const content = readContent({ contentFile: opts.contentFile });
        const ctx = runTokenContext();
        const comment = (await ctx.api.designProposal(await resolveIssueId(arg, ctx), content)) as { id?: string } | undefined;
        if (opts.json) printJson(comment);
        else printLine(`design proposal posted (comment ${comment?.id ?? '?'}); now set the status to proposal_review`);
      }),
    );

  registerSubIssueCommands(issue);
  registerChecklistCommand(issue);
  registerAttachmentCommands(issue);
}
