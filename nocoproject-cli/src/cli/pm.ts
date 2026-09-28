/**
 * `nocoproject pm projects | issues | issue | inbox | metrics | knowledge` (iteration 4 §C): the
 * project-manager agent's read-only view across projects, via `GET /np/agent/pm/*`. Run-token mode;
 * the server only answers runs of agents with `kind = 'manager'` (otherwise 403 `MANAGER_ONLY`, exit 3)
 * and filters everything by what the run's asker (`actorUserId`) can see.
 */
import type { Command } from 'commander';
import { z } from 'zod';
import { HttpError } from '../api/client.js';
import type { InboxItemV3, KnowledgeDocSummary, MetricsReport, PmIssueDetail, PmIssueListPage, PmIssueListQuery, ProjectListItem } from '../protocol.js';
import { ERROR_MANAGER_ONLY } from '../protocol.js';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt, runTokenContext } from './run-token.js';

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** `--since`: a relative age (`30m`, `12h`, `7d`, `2w`) or an ISO date / time → ISO timestamp. */
export function sinceToIso(value: string, now = Date.now()): string {
  const text = value.trim();
  const rel = text.match(/^(\d+)([mhdw])$/i);
  if (rel) return new Date(now - Number(rel[1]) * (UNIT_MS[(rel[2] as string).toLowerCase()] as number)).toISOString();
  const at = /^\d{4}-\d{2}-\d{2}/.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(at)) throw new CliError(`invalid --since "${value}": use 30m, 12h, 7d, 2w or an ISO date`, EXIT.validation, 'INVALID_SINCE');
  return new Date(at).toISOString();
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/** Like `action`, but turns 403 `MANAGER_ONLY` into a clear exit-3 error. */
function pmAction<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return action(async (...args: A) => {
    try {
      await fn(...args);
    } catch (error) {
      if (error instanceof HttpError && error.code === ERROR_MANAGER_ONLY) {
        throw new CliError('pm commands are only available to project-manager agents (agent kind "manager"); this run’s agent is not one', EXIT.auth, ERROR_MANAGER_ONLY);
      }
      throw error;
    }
  });
}

export interface PmIssuesOpts extends JsonOpt {
  project?: string;
  status?: string;
  owner?: string;
  executor?: string;
  q?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}

/** Maps the flags to the `GET /np/agent/pm/issues` query; only given flags are sent. */
export function pmIssuesQuery(opts: PmIssuesOpts, now = Date.now()): PmIssueListQuery {
  return {
    ...(opts.project ? { projectId: opts.project } : {}),
    ...(opts.status ? { statusKey: opts.status } : {}),
    ...(opts.owner ? { ownerUserId: opts.owner } : {}),
    ...(opts.executor ? { executorId: opts.executor } : {}),
    ...(opts.q ? { q: opts.q } : {}),
    ...(opts.since ? { updatedSince: sinceToIso(opts.since, now) } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
  };
}

function printProjects(list: readonly ProjectListItem[]): void {
  if (list.length === 0) return printLine('(no projects)');
  for (const p of list) {
    const counts = p.issueCounts ? `, ${p.issueCounts.done}/${p.issueCounts.total} done` : '';
    printLine(`${p.name}  (${p.id}${p.status ? `, ${p.status}` : ''}${counts}${p.leadName ? `, lead ${p.leadName}` : ''})`);
  }
}

function printIssues(page: PmIssueListPage): void {
  if (page.data.length === 0) printLine('(no issues)');
  for (const i of page.data) {
    const who = [i.ownerName ? `owner ${i.ownerName}` : '', i.executorName ? `executor ${i.executorName}` : ''].filter(Boolean).join(', ');
    printLine(`${i.identifier}  [${i.statusKey}]  ${i.title}${who ? `  (${who})` : ''}`);
  }
  if (page.nextCursor) printLine(`more: --cursor ${page.nextCursor}`);
}

function printIssueDetail(d: PmIssueDetail): void {
  const i = d.issue;
  printLine(`${i.identifier}  ${i.title}`);
  printLine(`status: ${i.statusKey}   priority: ${i.priority}   owner: ${i.ownerName ?? '-'}   executor: ${i.executorName ?? '-'}${i.process ? `   process: ${i.process}` : ''}`);
  printLine();
  printLine(i.description?.trim() || '(no description)');
  printLine();
  printLine(`comments: ${d.comments?.length ?? 0}   activities: ${d.activities?.length ?? 0}   runs: ${d.runs?.length ?? 0}   pull requests: ${d.pullRequests?.length ?? 0}   sub-issues: ${d.subtasks?.length ?? 0}`);
  printLine('(use --json for the full record)');
}

function printInbox(items: readonly InboxItemV3[]): void {
  if (items.length === 0) return printLine('(nothing waiting)');
  for (const item of items) printLine(`[${item.type}] ${item.issueIdentifier ? `${item.issueIdentifier} ` : ''}${item.title}`);
}

function printMetrics(m: MetricsReport): void {
  printLine(`metrics ${m.from} → ${m.to}${m.projectId ? ` (project ${m.projectId})` : ''}`);
  const share = m.aiShare?.share;
  printLine(`AI share: ${share === null || share === undefined ? 'n/a' : `${Math.round(share * 100)}%`} (${m.aiShare?.deliveredByAgent ?? 0}/${m.aiShare?.deliveredTotal ?? 0} delivered)`);
  printLine(`runs: ${m.reliability?.runs ?? 0} (${m.reliability?.failedRuns ?? 0} failed)   open decisions: ${m.humanLoad?.openDecisions ?? 0}`);
  printLine('(use --json for the full report)');
}

function printKnowledge(docs: readonly KnowledgeDocSummary[]): void {
  if (docs.length === 0) return printLine('(no knowledge documents)');
  for (const d of docs) printLine(`${d.slug}  ${d.title}  (${d.projectName ?? (d.projectId ? d.projectId : 'system')})`);
}

export function registerPmCommands(program: Command): void {
  const pm = program.command('pm').description('Project-manager reads across projects (run-token mode, manager agents only)');
  const out = <T>(opts: JsonOpt, data: T, text: (d: T) => void): void => (opts.json ? printJson(data) : text(data));

  pm.command('projects')
    .description('List every project the asker can see')
    .option('--json', 'JSON output')
    .action(pmAction(async (opts: JsonOpt) => out(opts, (await runTokenContext().api.pmProjects()) ?? [], printProjects)));

  pm.command('issues')
    .description('Search issues across projects ({ data, nextCursor })')
    .option('--project <id>', 'only this project')
    .option('--status <key>', 'only this status key')
    .option('--owner <userId>', '`me` (the person who asked) or a user id')
    .option('--executor <agentId>', 'only issues executed by this agent')
    .option('--q <text>', 'search title and description')
    .option('--since <age>', 'updated within 30m, 12h, 7d, 2w, or since an ISO date')
    .option('--limit <n>', 'page size (server default 50, max 100)', (v) => z.coerce.number().int().positive().max(100).parse(v))
    .option('--cursor <cursor>', 'next page (nextCursor of the previous page)')
    .option('--json', 'JSON output')
    .action(pmAction(async (opts: PmIssuesOpts) => out(opts, await runTokenContext().api.pmIssues(pmIssuesQuery(opts)), printIssues)));

  pm.command('issue <issue>')
    .description('One issue in full: comments, activities, runs, pull requests, sub-issues')
    .option('--json', 'JSON output')
    .action(pmAction(async (ref: string, opts: JsonOpt) => out(opts, await runTokenContext().api.pmIssue(ref.trim()), printIssueDetail)));

  pm.command('inbox')
    .description('The decisions waiting for the person who asked')
    .option('--kind <kind>', 'inbox kind', 'decision')
    .option('--json', 'JSON output')
    .action(pmAction(async (opts: JsonOpt & { kind: string }) => out(opts, (await runTokenContext().api.pmInbox(opts.kind)) ?? [], printInbox)));

  pm.command('metrics')
    .description('The metrics report')
    .option('--from <date>', 'first day (YYYY-MM-DD, UTC)')
    .option('--to <date>', 'last day (YYYY-MM-DD, UTC)')
    .option('--project <id>', 'only this project')
    .option('--json', 'JSON output')
    .action(
      pmAction(async (opts: JsonOpt & { from?: string; to?: string; project?: string }) => {
        const q = { from: opts.from ? DATE.parse(opts.from) : undefined, to: opts.to ? DATE.parse(opts.to) : undefined, projectId: opts.project };
        out(opts, await runTokenContext().api.pmMetrics(q), printMetrics);
      }),
    );

  pm.command('knowledge')
    .description('Knowledge documents of every visible project and system-wide (no content)')
    .option('--project <id>', 'only this project (plus system-wide)')
    .option('--q <text>', 'search')
    .option('--json', 'JSON output')
    .action(pmAction(async (opts: JsonOpt & { project?: string; q?: string }) => out(opts, (await runTokenContext().api.pmKnowledge({ projectId: opts.project, q: opts.q })) ?? [], printKnowledge)));
}
