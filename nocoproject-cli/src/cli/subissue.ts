/**
 * Phase 1 agent commands for sub-issues and dependencies (contract §D, §I):
 *   issue create / issue children / issue dependency add|remove
 * Identifiers (`NP-12`) are accepted wherever ids are.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import type { AgentCreateIssueRequest, SubtaskSummary } from '../protocol.js';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt, resolveIssueId, resolveIssueRef, type RunTokenContext, runTokenContext, splitList } from './run-token.js';

const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;

const CreateInput = z
  .object({
    title: z.string().trim().min(1, 'title is empty'),
    description: z.string().optional(),
    descriptionFile: z.string().optional(),
    parent: z.string().trim().min(1).optional(),
    stage: z.coerce.number().int().min(0).optional(),
    blockedBy: z.string().optional(),
    executor: z.string().trim().min(1).optional(),
    priority: z.enum(PRIORITIES).optional(),
    label: z.string().optional(),
  })
  .refine((v) => v.description === undefined || v.descriptionFile === undefined, {
    message: 'pass at most one of --description or --description-file',
  });

type CreateOpts = z.infer<typeof CreateInput> & JsonOpt;

function readDescription(opts: CreateOpts): string | undefined {
  if (opts.descriptionFile === undefined) return opts.description;
  const path = resolve(opts.descriptionFile);
  if (!existsSync(path)) throw new CliError(`description file not found: ${path}`, EXIT.validation, 'FILE_NOT_FOUND');
  return readFileSync(path, 'utf8');
}

/** `self` / `none` pass through; a delegation target's name (from context.json) maps to its id. */
function resolveExecutor(value: string | undefined, ctx: RunTokenContext): string | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'self' || lower === 'none') return lower;
  const target = ctx.runContext?.agent.delegationTargets.find((t) => t.name.toLowerCase() === lower);
  return target ? target.id : value;
}

export async function buildCreateRequest(opts: CreateOpts, ctx: RunTokenContext): Promise<AgentCreateIssueRequest> {
  const blockedBy: string[] = [];
  for (const ref of splitList(opts.blockedBy)) blockedBy.push(await resolveIssueRef(ref, ctx));
  const labels = splitList(opts.label);
  const body: Record<string, unknown> = { title: opts.title };
  const description = readDescription(opts);
  if (description !== undefined) body.description = description;
  if (opts.parent) body.parentIssueId = await resolveIssueRef(opts.parent, ctx);
  if (opts.stage !== undefined) body.stage = opts.stage;
  if (blockedBy.length) body.blockedBy = blockedBy;
  if (opts.priority) body.priority = opts.priority;
  if (labels.length) body.labels = labels;
  const executor = resolveExecutor(opts.executor, ctx);
  if (executor) body.executor = executor;
  return body as unknown as AgentCreateIssueRequest;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function printCreated(data: unknown): void {
  const issue = isObj(data) && isObj(data.issue) ? data.issue : isObj(data) ? data : {};
  const key = typeof issue.identifier === 'string' ? issue.identifier : String(issue.id ?? '(unknown)');
  printLine(`created ${key}${typeof issue.title === 'string' ? ` "${issue.title}"` : ''}`);
  const proposal = isObj(data) && isObj(data.proposal) ? data.proposal : undefined;
  if (proposal && typeof proposal.status === 'string') printLine(`executor proposal: ${proposal.status}`);
}

function printChildren(children: readonly SubtaskSummary[]): void {
  if (children.length === 0) return printLine('(no sub-issues)');
  for (const c of children) {
    const stage = c.stage === null || c.stage === undefined ? 'no stage' : `stage ${c.stage}`;
    const executor = c.executorName ? ` — ${c.executorName}` : ' — no executor';
    const blocked = c.blockedCount > 0 ? `  (waiting on ${c.blockedCount})` : '';
    printLine(`${c.identifier}  [${stage}]  ${c.statusKey}  ${c.title}${executor}${blocked}`);
  }
}

function registerCreate(issue: Command): void {
  issue
    .command('create')
    .description('Create a sub-issue (defaults to a child of the run’s issue)')
    .requiredOption('--title <title>', 'title')
    .option('--description <text>', 'Markdown description')
    .option('--description-file <path>', 'read the Markdown description from a file')
    .option('--parent <issue>', 'parent issue (default: the run’s issue)')
    .option('--stage <n>', 'batch number; lower stages must finish first')
    .option('--blocked-by <issues>', 'comma-separated issues this one waits for')
    .option('--executor <who>', 'self | none | <agentId> (default none)')
    .option('--priority <p>', PRIORITIES.join(' | '))
    .option('--label <names>', 'comma-separated label names (created if missing)')
    .option('--json', 'JSON output')
    .action(
      action(async (raw: CreateOpts) => {
        const opts = CreateInput.parse(raw) as CreateOpts;
        const ctx = runTokenContext();
        const data = await ctx.api.createIssue(await buildCreateRequest(opts, ctx));
        if (raw.json) printJson(data);
        else printCreated(data);
      }),
    );
}

function registerDependency(issue: Command): void {
  const dependency = issue.command('dependency').description('Blocked-by dependencies between issues');
  for (const verb of ['add', 'remove'] as const) {
    dependency
      .command(`${verb} [issue]`)
      .description(verb === 'add' ? 'Mark an issue as blocked by others' : 'Remove blocked-by dependencies')
      .requiredOption('--blocked-by <issues>', 'comma-separated blocking issues')
      .option('--json', 'JSON output')
      .action(
        action(async (arg: string | undefined, opts: JsonOpt & { blockedBy: string }) => {
          const ctx = runTokenContext();
          const id = await resolveIssueId(arg, ctx);
          const others = splitList(opts.blockedBy);
          if (others.length === 0) throw new CliError('--blocked-by is empty', EXIT.validation, 'VALIDATION_ERROR');
          const results: unknown[] = [];
          for (const other of others) {
            const otherId = await resolveIssueRef(other, ctx);
            results.push(verb === 'add' ? await ctx.api.addDependency(id, otherId) : await ctx.api.removeDependency(id, otherId));
          }
          if (opts.json) printJson(results.length === 1 ? (results[0] ?? { ok: true }) : results);
          else printLine(`${verb === 'add' ? 'added' : 'removed'} ${others.length} blocked-by dependenc${others.length === 1 ? 'y' : 'ies'}`);
        }),
      );
  }
}

export function registerSubIssueCommands(issue: Command): void {
  registerCreate(issue);
  issue
    .command('children [issue]')
    .description('List sub-issues with stage, status and how many blockers each waits on')
    .option('--json', 'JSON output')
    .action(
      action(async (arg: string | undefined, opts: JsonOpt) => {
        const ctx = runTokenContext();
        const data = await ctx.api.children(await resolveIssueId(arg, ctx));
        if (opts.json) printJson(data ?? []);
        else printChildren(data ?? []);
      }),
    );
  registerDependency(issue);
}
